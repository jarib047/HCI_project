# Gemini Chatbot with Delay Testing

A FastAPI-based chatbot application for testing Gemini response delays. The app supports embedded use in Qualtrics via `postMessage`, local CSV logging, and a pricing-label manipulation tied to latency and condition.

## Features

- Real-time streaming chat interface with Gemini
- Configurable latency conditions
- Pricing-label display tied to latency and condition
- Participant and question tracking
- Local CSV logging for chat and client events
- Combined CSV export of all participant logs

## Prerequisites

- Python 3.9+
- Gemini API key

## Installation

1. Clone the repository.
2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Create a `.env` file with:

```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash
DOWNLOAD_API_KEY=your_secure_api_key_here
```

## Running the Application

### Local Development

```bash
python -m uvicorn delay_C_Test:app --reload --port 8000
```

### Production

```bash
python -m uvicorn delay_C_Test:app --host 0.0.0.0 --port $PORT
```

## Usage

### Direct Access

Open `http://localhost:8000`.

### Iframe Embedding (Qualtrics Integration)

The application is designed to receive configuration via `postMessage` when embedded in an iframe. The parent window should send a message with this structure:

```javascript
iframe.contentWindow.postMessage({
  pid: "participant_123",
  qid: "Q1",
  dcond: 1,
  condition: "direct"
}, "*");
```

**Delay Condition Mapping**

- `dcond: 1` -> `2.0` seconds delay
- `dcond: 2` -> `9.0` seconds delay
- `dcond: 3` -> `20.0` seconds delay
- Default -> `3.0` seconds delay

**Pricing Condition Mapping**

- `condition: "direct"` -> `Gemini - $8/month`, `Gemini - $20/month`, `Gemini - $250/month` for 2s, 9s, and 20s respectively
- `condition: "alternate"` -> a pseudo-random Gemini price label from those three options
- Default -> `"direct"`

**Note:** The application currently reads embedded-study metadata from `postMessage`, not URL parameters.

## API Endpoints

- `GET /` - Main chat interface
- `POST /chat-stream` - Streaming chat endpoint
- `POST /client-log` - Client-side event logging
- `GET /download-log/{pid}` - Download one participant chat log
- `GET /download-all-logs?api_key=YOUR_KEY` - Download the combined chat logs

## Data Storage

- Chat interactions are stored in `logs/chat/participant_{pid}.csv`
- Client events are stored in `logs/client/participant_{pid}.csv`
- On Render, logs are stored under `/tmp/chat_logs`

## Project Structure

```text
delay_C_Test.py
requirements.txt
start.sh
static/
templates/
logs/
```
