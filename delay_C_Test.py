from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from botocore.exceptions import ClientError
from pathlib import Path
from datetime import datetime, timezone
from dotenv import load_dotenv
from filelock import FileLock
import asyncio
import time
import openai
import os
import csv
import io
import boto3
import json
import sys
import anyio

# Load environment variables
load_dotenv()

# Initialize OpenAI client
client = openai.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Initialize AWS S3 client
s3_client = boto3.client(
    's3',
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
    region_name=os.getenv('AWS_REGION', 'us-east-1')
)
S3_BUCKET = os.getenv('AWS_S3_BUCKET_NAME')
def get_s3_key_for_pid(pid):
    """Generate S3 key for a specific participant ID."""
    return f'client_logs/participant_{pid}.csv'

# FastAPI app setup
app = FastAPI()

# Verify S3 configuration at startup
@app.on_event("startup")
async def startup_event():
    if not S3_BUCKET:
        print("WARNING: AWS_S3_BUCKET_NAME environment variable is not set")
    if not os.getenv('AWS_ACCESS_KEY_ID'):
        print("WARNING: AWS_ACCESS_KEY_ID environment variable is not set")
    if not os.getenv('AWS_SECRET_ACCESS_KEY'):
        print("WARNING: AWS_SECRET_ACCESS_KEY environment variable is not set")
    
    try:
        # Test S3 connection
        await anyio.to_thread.run_sync(
            lambda: s3_client.head_bucket(Bucket=S3_BUCKET)
        )
        print(f"Successfully connected to S3 bucket: {S3_BUCKET}")
    except Exception as e:
        print(f"WARNING: Failed to connect to S3: {str(e)}")

# Static and template setup
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

@app.get("/", response_class=HTMLResponse)
async def serve_index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# Update the log path to use /tmp
import os
from pathlib import Path

# Near the top of your file where you define paths
LOG_DIR = '/tmp/chat_logs' if os.getenv('RENDER') else 'logs'
LOG_PATH = Path(LOG_DIR) / 'chat_log.csv'

# Update the directory creation to use this path
Path(LOG_DIR).mkdir(parents=True, exist_ok=True)

# Safe CSV field formatting to prevent CSV injection
def safe_csv_field(field_value):
    """Prefix potentially dangerous CSV fields to prevent formula injection."""
    if isinstance(field_value, str) and field_value and field_value[0] in "=+-@'\"":
        return "'" + field_value
    return field_value

# Thread-safe logging helper
def _write_csv_row(row, log_path):
    """Write a single row to CSV with proper header handling."""
    header = [
        "Timestamp", "ParticipantID", "QuestionID",
        "DelayCondition", "PromptText", "GPT Reply",
        "ActualLatency", "LatencyExceeded"
    ]
    write_header = not log_path.exists()
    
    with log_path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(header)
        writer.writerow(row)

async def append_to_s3_csv(new_row, pid):
    """Append a row to a participant-specific CSV file in S3."""
    try:
        s3_key = get_s3_key_for_pid(pid)
        
        # Try to get existing file
        try:
            response = await anyio.to_thread.run_sync(
                lambda: s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key)
            )
            existing_content = await anyio.to_thread.run_sync(
                lambda: response['Body'].read().decode('utf-8')
            )
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey':
                # File doesn't exist yet, start with header
                existing_content = ','.join([
                    "Timestamp", "ParticipantID", "QuestionID",
                    "DelayCondition", "PromptText", "GPT Reply",
                    "ActualLatency", "LatencyExceeded", "TaskCondition"
                ]) + '\n'
            else:
                raise

        # Create a string buffer and csv writer
        output = io.StringIO()
        writer = csv.writer(output)
        
        # Write existing content without header
        output.write(existing_content)
        if not existing_content.endswith('\n'):
            output.write('\n')
        
        # Append new row
        writer.writerow(new_row)
        
        # Upload back to S3
        await anyio.to_thread.run_sync(
            lambda: s3_client.put_object(
                Bucket=S3_BUCKET,
                Key=s3_key,
                Body=output.getvalue().encode('utf-8'),
                ContentType='text/csv'
            )
        )
    except Exception as e:
        print(f"Error writing to S3: {str(e)}")
        raise



# ---------------------------------------------
# GPT CHAT INTERACTION LOGGING
# ---------------------------------------------
async def log_chat_interaction(message: str,
                               reply: str,
                               gpt_time: float,
                               delay_condition: float,
                               pid: str,
                               question: str,
                               task_condition: str):
    """Log a single GPT interaction (server side) to participant-specific CSV in S3."""
    latency_exceeded = "Yes" if gpt_time > delay_condition else "No"
    row = [
        datetime.now(timezone.utc).isoformat(),  # Timestamp (UTC)
        safe_csv_field(str(pid)),
        safe_csv_field(str(question)),
        delay_condition,
        safe_csv_field(message),
        safe_csv_field(reply),
        round(gpt_time, 3),
        latency_exceeded,
        task_condition
    ]
    await append_to_s3_csv(row, pid)

# ---------------------------------------------
# CLIENT-SIDE EVENT LOGGING
# ---------------------------------------------

def get_s3_client_key_for_pid(pid: str):
    """Generate S3 key for client-side events for a specific participant ID."""
    return f'client_logs/participant_{pid}.csv'

async def append_to_s3_client_csv(new_row, pid):
    """Append a row to a participant-specific client events CSV file in S3."""
    try:
        s3_key = get_s3_client_key_for_pid(pid)

        # Attempt to fetch existing file, otherwise initialise with header
        try:
            response = await anyio.to_thread.run_sync(
                lambda: s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key)
            )
            existing_content = await anyio.to_thread.run_sync(
                lambda: response['Body'].read().decode('utf-8')
            )
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey':
                existing_content = ','.join([
                    "Timestamp", "ParticipantID", "QuestionID", "DelayCondition", "TaskCondition",
                    "EventType", "EventTarget", "Content", "LatencyFT", "LatencyLT"
                ]) + '\n'
            else:
                raise

        # Build new CSV content
        output = io.StringIO()
        writer = csv.writer(output)

        # Write existing content
        output.write(existing_content)
        if not existing_content.endswith('\n'):
            output.write('\n')

        # Append new row
        writer.writerow(new_row)

        # Upload back to S3
        await anyio.to_thread.run_sync(
            lambda: s3_client.put_object(
                Bucket=S3_BUCKET,
                Key=s3_key,
                Body=output.getvalue().encode('utf-8'),
                ContentType='text/csv'
            )
        )
    except Exception as e:
        print(f"Error writing client log to S3: {str(e)}")
        raise

class ClientLogRequest(BaseModel):
    timestamp: str
    pid: str
    qid: str
    delay_condition: float
    task_condition: str
    type: str
    target: str = ""
    content: str = ""
    latency_ft: float = 0.0
    latency_lt: float = 0.0

@app.post("/client-log")
async def handle_client_log(log: ClientLogRequest):
    """Receive client-side log event and store it in S3 (or local fallback)."""
    try:
        # Sanitize and prepare row
        row = [
            safe_csv_field(log.timestamp),
            safe_csv_field(str(log.pid)),
            safe_csv_field(str(log.qid)),
            log.delay_condition,
            safe_csv_field(str(log.task_condition)),
            safe_csv_field(str(log.type)),
            safe_csv_field(str(log.target)),
            safe_csv_field(str(log.content)),
            round(float(log.latency_ft or 0), 3),
            round(float(log.latency_lt or 0), 3)
        ]

        # Append to S3 (or local file)
        await append_to_s3_client_csv(row, log.pid)

        return {"status": "ok"}
    except Exception as e:
        print(f"Failed to handle client log: {e}")
        return {"error": str(e)}

# Message model for conversation history
class Message(BaseModel):
    role: str  # 'user' or 'assistant'
    content: str

# Updated API input model
class ChatRequest(BaseModel):
    message: str
    conversation_history: list[Message] = []  # Previous messages in the conversation
    delay: float = 1.0
    pid: str = "unknown"
    qid: str = "unspecified"
    task_condition: str = "unknown"
    start_time_s: float = 0.0

# Streaming chat endpoint
@app.post("/chat-stream")
async def chat_stream(request: ChatRequest):
    try:
        start_time = time.perf_counter()
        
        # Pre-calculate the exact target time for first chunk
        target_first_chunk_time = start_time + request.delay

        # Prepare messages for OpenAI
        messages = [
            # Convert conversation history to OpenAI format
            *[{"role": msg.role, "content": msg.content} for msg in request.conversation_history],
            # Add the current message
            {"role": "user", "content": request.message}
        ]

        async def generate():
            """
            Wait exactly request.delay seconds while collecting all chunks.
            Then start streaming all collected chunks at regular intervals,
            ensuring the first chunk is streamed exactly when the delay is over.
            """
            try:
                response_chunks = []
                buffer = []
                chunk_interval = 0.04  # seconds between chunks (≈25 tokens/s)
                delay_completed = False
                first_chunk_sent = False
                last_stream_time = None  # Track when we last streamed a chunk
                first_chunk_target_time = target_first_chunk_time  # Exact target time for first chunk
                
                # Timing compensation factors (calibrated for typical overhead)
                processing_overhead = 0.15  # Estimated 150ms for processing overhead
                async_overhead = 0.05      # Estimated 50ms for async scheduling
                total_compensation = processing_overhead + async_overhead
                
                # Adjust target time to compensate for overhead
                compensated_target_time = target_first_chunk_time - total_compensation
                
                # Adaptive compensation based on request delay
                if request.delay >= 2.0:
                    # For longer delays, we can be more aggressive with compensation
                    adaptive_compensation = 0.25  # 250ms for longer delays
                elif request.delay >= 1.0:
                    # For medium delays
                    adaptive_compensation = 0.20  # 200ms for medium delays
                elif request.delay >= 0.5:
                    # For short delays, be more aggressive
                    adaptive_compensation = 0.15  # 150ms for short delays
                else:
                    # For very short delays, be very aggressive
                    adaptive_compensation = 0.20  # 200ms for very short delays
                
                # Use the more aggressive compensation
                final_compensation = max(total_compensation, adaptive_compensation)
                final_compensated_target = target_first_chunk_time - final_compensation
                
                # For very short delays, add extra preparation time
                if request.delay < 1.0:
                    # Start preparing earlier for short delays
                    preparation_trigger = request.delay * 0.3  # Start at 30% of delay
                else:
                    preparation_trigger = request.delay - final_compensation
                
                # Dynamic compensation based on response characteristics
                # For very short delays, we need to be even more aggressive
                if request.delay < 0.5:
                    # Ultra-short delays need maximum compensation
                    dynamic_compensation = 0.25  # 250ms for ultra-short delays
                    final_compensated_target = target_first_chunk_time - dynamic_compensation

                # OpenAI streaming call
                stream = client.chat.completions.create(
                    model="gpt-4o",
                    messages=messages,
                    stream=True
                )

                # Collect chunks and check if delay is completed during collection
                for chunk in stream:
                    if chunk.choices[0].delta.content is None:
                        continue

                    content = chunk.choices[0].delta.content
                    response_chunks.append(content)
                    buffer.append(content)

                    # Check if delay has been reached while collecting
                    current_time = time.perf_counter()
                    elapsed_since_start = current_time - start_time
                    
                    # Early preparation for short delays
                    if not delay_completed and request.delay < 1.0 and elapsed_since_start >= preparation_trigger:
                        # For short delays, start preparing the first chunk early
                        if buffer:
                            # Pre-serialize the first chunk to reduce overhead
                            first_chunk_data = json.dumps({'content': buffer[0], 'type': 'content'})
                    
                    # Predictive timing: start processing slightly before target to compensate for overhead
                    if not delay_completed and elapsed_since_start >= preparation_trigger:
                        delay_completed = True
                        
                        # Stream buffered chunks with precise timing
                        for i, buffered_content in enumerate(buffer):
                            if i == 0:
                                # Wait until we're very close to the target time
                                while time.perf_counter() < final_compensated_target:
                                    await asyncio.sleep(0.001)  # 1ms precision
                                
                                # Send first chunk at compensated target time
                                actual_time = time.perf_counter()
                                
                                # Use pre-serialized data for short delays if available
                                if request.delay < 1.0 and 'first_chunk_data' in locals():
                                    yield f"data: {first_chunk_data}\n\n"
                                else:
                                    yield f"data: {json.dumps({'content': buffered_content, 'type': 'content'})}\n\n"
                                last_stream_time = actual_time
                            else:
                                # Wait for chunk_interval before sending subsequent chunks
                                await asyncio.sleep(chunk_interval)
                                yield f"data: {json.dumps({'content': buffered_content, 'type': 'content'})}\n\n"
                                last_stream_time = time.perf_counter()
                        buffer = []  # Clear buffer since we've streamed everything
                        first_chunk_sent = True
                        # Continue the loop to process remaining chunks - they will be streamed immediately
                    
                    # If delay is already completed, stream new chunks with consistent timing
                    elif delay_completed:
                        # Calculate time since last stream
                        current_time = time.perf_counter()
                        if last_stream_time is not None:
                            time_since_last = current_time - last_stream_time
                            if time_since_last < chunk_interval:
                                # Wait for the remaining time to maintain consistent intervals
                                wait_time = chunk_interval - time_since_last
                                await asyncio.sleep(wait_time)
                        
                        yield f"data: {json.dumps({'content': content, 'type': 'content'})}\n\n"
                        last_stream_time = current_time
                        continue  # Skip adding to buffer since we've already streamed it

                # If delay wasn't completed during collection, wait for it now
                if not delay_completed and not first_chunk_sent:
                    current_time = time.perf_counter()
                    elapsed_since_start = current_time - start_time
                    remaining_delay = max(0, request.delay - elapsed_since_start)
                    if remaining_delay > 0:
                        await asyncio.sleep(remaining_delay)

                    # Now start streaming all collected chunks at regular intervals
                    for i, content in enumerate(buffer):
                        if i == 0:
                            yield f"data: {json.dumps({'content': content, 'type': 'content'})}\n\n"
                            last_stream_time = time.perf_counter()
                        else:
                            await asyncio.sleep(chunk_interval)
                            yield f"data: {json.dumps({'content': content, 'type': 'content'})}\n\n"
                            last_stream_time = time.perf_counter()
                    first_chunk_sent = True

                # Ensure we always stream something if we have content (only if not already sent)
                if not delay_completed and not first_chunk_sent and buffer:
                    for i, content in enumerate(buffer):
                        if i == 0:
                            yield f"data: {json.dumps({'content': content, 'type': 'content'})}\n\n"
                            last_stream_time = time.perf_counter()
                        else:
                            await asyncio.sleep(chunk_interval)
                            yield f"data: {json.dumps({'content': content, 'type': 'content'})}\n\n"
                            last_stream_time = time.perf_counter()
                    first_chunk_sent = True

                # IMPORTANT: Only send completion signal after ALL content has been streamed
                # This ensures no content is lost due to premature completion
                
                # Send completion signal
                full_response = ''.join(response_chunks)
                total_elapsed = time.perf_counter() - start_time
                complete_message = f"data: {json.dumps({'type': 'complete', 'gpt_time': round(total_elapsed, 3), 'manual_delay': round(max(request.delay - total_elapsed, 0), 3)})}\n\n"
                yield complete_message


            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"


        return StreamingResponse(
            generate(),
            media_type="text/plain",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Content-Type": "text/plain; charset=utf-8"
            }
        )

    except Exception as e:
        async def error_generator():
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
        
        return StreamingResponse(
            error_generator(),
            media_type="text/plain"
        )

# POST endpoint that logs QuestionID
@app.post("/chat")
async def chat(request: ChatRequest):
    try:
        print(">>> Request payload:", request.dict())
        print(f"[START] Request: {request.message}", flush=True)
        start_time = time.perf_counter()

        # Prepare messages for OpenAI
        messages = [
            # Convert conversation history to OpenAI format
            *[{"role": msg.role, "content": msg.content} for msg in request.conversation_history],
            # Add the current message
            {"role": "user", "content": request.message}
        ]

        # OpenAI GPT call with conversation history
        response = client.chat.completions.create(
            model="gpt-4o",  # Using gpt-4o instead of gpt-4o which seems to be a typo
            messages=messages
        )


        reply = response.choices[0].message.content
        elapsed_time = time.perf_counter() - start_time

        # Optional manual delay to enforce DelayCondition
        remaining_delay = max(request.delay - elapsed_time, 0)
        await asyncio.sleep(remaining_delay)

        print(f"[DONE] GPT time: {elapsed_time:.3f}s | Manual delay: {remaining_delay:.3f}s", flush=True)

        # Log the interaction
        await log_chat_interaction(
            message=request.message,
            reply=reply,
            gpt_time=elapsed_time,
            delay_condition=request.delay,
            pid=request.pid,
            question=request.qid,
            task_condition=request.task_condition
        )

        return {
            "response": reply,
            "gpt_time": round(elapsed_time, 3),
            "manual_delay": round(remaining_delay, 3)
        }

    except Exception as e:
        return {"error": str(e)}

# File download routes
@app.get("/download-log/{pid}")
async def download_participant_log(pid: str):
    """Download log file for a specific participant."""
    try:
        # Check if we have AWS credentials configured
        if not all([os.getenv('AWS_ACCESS_KEY_ID'), 
                   os.getenv('AWS_SECRET_ACCESS_KEY'),
                   os.getenv('AWS_S3_BUCKET_NAME')]):
            print("ERROR: Missing AWS credentials")
            return {"error": "AWS credentials not configured"}

        s3_key = get_s3_key_for_pid(pid)
        print(f"Attempting to download from bucket: {S3_BUCKET}, key: {s3_key}")
        
        # Get the file from S3
        try:
            response = await anyio.to_thread.run_sync(
                lambda: s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key)
            )
        except ClientError as e:
            error_code = e.response['Error'].get('Code', 'Unknown')
            error_msg = e.response['Error'].get('Message', str(e))
            print(f"S3 Error: {error_code} - {error_msg}")
            if error_code == 'NoSuchKey':
                return {"error": f"No log file found for participant {pid} ({s3_key})"}
            elif error_code in ['InvalidAccessKeyId', 'SignatureDoesNotMatch']:
                return {"error": "AWS authentication failed"}
            elif error_code == 'NoSuchBucket':
                return {"error": "S3 bucket not found"}
            return {"error": f"S3 error: {error_code} - {error_msg}"}
        except Exception as e:
            print(f"Unexpected error during S3 get_object: {str(e)}")
            return {"error": f"Failed to access S3: {str(e)}"}
        
        try:
            # Read the content
            content = await anyio.to_thread.run_sync(
                lambda: response['Body'].read()
            )
            
            # Create a StreamingResponse
            return StreamingResponse(
                io.BytesIO(content),
                media_type='text/csv',
                headers={
                    "Content-Disposition": f"attachment; filename=participant_{pid}_log.csv",
                    "Content-Length": str(len(content))
                }
            )
        except Exception as e:
            print(f"Error reading S3 response: {str(e)}")
            return {"error": f"Failed to read S3 file: {str(e)}"}
            
    except Exception as e:
        print(f"Unexpected error in download_log: {str(e)}")
        return {"error": f"Internal server error: {str(e)}"}

async def generate_combined_csv():
    """Generator function to stream combined CSV content."""
    try:
        # List all participant files
        response = await anyio.to_thread.run_sync(
            lambda: s3_client.list_objects_v2(
                Bucket=S3_BUCKET,
                Prefix='client_logs/participant_'
            )
        )
        
        if 'Contents' not in response:
            yield b"No data found"
            return

        header_written = False
        all_files_processed = []
        
        # First pass: collect all files and their content
        for obj in response['Contents']:
            try:
                file_response = await anyio.to_thread.run_sync(
                    lambda: s3_client.get_object(
                        Bucket=S3_BUCKET,
                        Key=obj['Key']
                    )
                )
                
                # Read the entire file content
                content = await anyio.to_thread.run_sync(
                    lambda: file_response['Body'].read().decode('utf-8')
                )
                
                # Close the stream properly
                await anyio.to_thread.run_sync(lambda: file_response['Body'].close())
                
                # Split into lines and filter out empty lines
                lines = [line.strip() for line in content.split('\n') if line.strip()]
                
                if lines:
                    all_files_processed.append({
                        'key': obj['Key'],
                        'lines': lines,
                        'header': lines[0] if lines else None,
                        'data': lines[1:] if len(lines) > 1 else []
                    })
                
            except Exception as e:
                print(f"Error reading file {obj['Key']}: {str(e)}")
                continue
        
        if not all_files_processed:
            yield b"No valid data found"
            return
        
        # Write header from first file
        first_file = all_files_processed[0]
        if first_file['header']:
            yield (first_file['header'] + '\n').encode('utf-8')
            header_written = True
        
        # Write data from all files
        for file_data in all_files_processed:
            try:
                if file_data['data']:
                    # Join data rows with newlines and add final newline
                    data_content = '\n'.join(file_data['data']) + '\n'
                    yield data_content.encode('utf-8')
            except Exception as e:
                print(f"Error writing data from {file_data['key']}: {str(e)}")
                continue
                
    except Exception as e:
        print(f"Error in generate_combined_csv: {str(e)}")
        yield str(e).encode('utf-8')

@app.get("/download-all-logs")
async def download_all_logs(api_key: str = None):
    """Download all participant log files as a combined CSV. Requires API key authentication."""
    try:
        # Check API key
        required_api_key = os.getenv('DOWNLOAD_API_KEY')
        if not required_api_key:
            return {"error": "Download functionality not configured"}
        
        if not api_key or api_key != required_api_key:
            return {"error": "Unauthorized: Invalid or missing API key"}
        
        # Check AWS credentials
        if not all([os.getenv('AWS_ACCESS_KEY_ID'), 
                   os.getenv('AWS_SECRET_ACCESS_KEY'),
                   os.getenv('AWS_S3_BUCKET_NAME')]):
            return {"error": "AWS credentials not configured"}

        return StreamingResponse(
            generate_combined_csv(),
            media_type='text/csv',
            headers={
                "Content-Disposition": "attachment; filename=all_participants_log.csv"
            }
        )

    except Exception as e:
        print(f"Unexpected error in download_all_logs: {str(e)}")
        return {"error": f"Internal server error: {str(e)}"}
