# GPT Chatbot with Delay Testing

A FastAPI-based chatbot application for testing GPT response delays. This application allows you to configure artificial delays for GPT responses and logs interactions to AWS S3.

## Features

- Real-time streaming chat interface with GPT-4
- Configurable response delays for testing purposes
- Participant tracking and question-based logging
- AWS S3 integration for data persistence
- Client-side event logging
- Combined CSV export of all participant logs

## Prerequisites

- Python 3.8+
- OpenAI API key
- AWS S3 bucket and credentials

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd gpt-chatbot
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Configure environment variables:
   - Copy `.env.example` to `.env`
   - Fill in your API keys and AWS credentials

## Configuration

Create a `.env` file with the following variables:

```env
OPENAI_API_KEY=your_openai_api_key_here
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
AWS_REGION=us-east-1
AWS_S3_BUCKET_NAME=your_s3_bucket_name
DOWNLOAD_API_KEY=your_secure_api_key_here
```

## Running the Application

### Local Development

```bash
python -m uvicorn delay_C_Test:app --reload --port 8000
```

### Production (using start.sh)

```bash
bash start.sh
```

The application will start on the configured port (default: 8000 or $PORT environment variable).

## Usage

### Direct Access
1. Open your browser and navigate to `http://localhost:8000`
2. Enter your message and interact with the chatbot
3. All interactions are automatically logged to S3

### Iframe Embedding (Qualtrics Integration)

The application is designed to receive configuration via `postMessage` when embedded in an iframe (e.g., in Qualtrics surveys). The parent window should send a message with the following structure:

```javascript
iframe.contentWindow.postMessage({
  pid: "participant_123",    // Participant ID
  qid: "Q1",                 // Question ID
  dcond: 1,                  // Delay condition: 1=2s, 2=9s, 3=20s
  tcond: 1                   // Task condition: 1=CREATIVE, 2=ADVICE
}, "*");
```

**Delay Condition Mapping:**
- `dcond: 1` → 2.0 seconds delay
- `dcond: 2` → 9.0 seconds delay
- `dcond: 3` → 20.0 seconds delay
- Default → 3.0 seconds delay

**Task Condition Mapping:**
- `tcond: 1` → "CREATIVE"
- `tcond: 2` → "ADVICE"
- Default → "unknown"

**Note:** The application currently only supports configuration via postMessage, not URL parameters.

## API Endpoints

- `GET /` - Main chat interface
- `POST /chat-stream` - Streaming chat endpoint
- `POST /client-log` - Client-side event logging
- `GET /download-all-logs?api_key=YOUR_KEY` - Download combined CSV of all participant logs (requires API key authentication)

## Data Storage

- Chat interactions are stored in S3 under `client_logs/participant_{pid}.csv`
- Local fallback logs are stored in `logs/` directory (or `/tmp/chat_logs` on Render)

## Project Structure

```
├── delay_C_Test.py      # Main FastAPI application
├── requirements.txt      # Python dependencies
├── start.sh             # Production startup script
├── static/              # Frontend assets
│   ├── main.js         # JavaScript logic
│   └── style.css       # Styles
├── templates/           # HTML templates
│   └── index.html
└── logs/               # Local log storage (fallback)
```

## License

MIT License - see [LICENSE](LICENSE) file for details.
