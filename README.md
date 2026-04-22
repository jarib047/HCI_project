# Gemini Chatbot with Delay Testing

A FastAPI-based chatbot application for testing Gemini response delays. This application allows you to configure artificial delays for model responses and logs interactions to local CSV files.

## Features

- Real-time streaming chat interface with Gemini
- Configurable response delays for testing purposes
- Participant tracking and question-based logging
- Local CSV logging for chat and client events
- Client-side event logging
- Combined CSV export of all participant logs

## Prerequisites

- Python 3.9+
- Gemini API key

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
   - Create a `.env` file
   - Fill in your Gemini and download API keys

## Configuration

Create a `.env` file with the following variables:

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

### Production (using start.sh)

```bash
bash start.sh
```

The application will start on the configured port (default: 8000 or $PORT environment variable).

## Usage

### Direct Access
1. Open your browser and navigate to `http://localhost:8000`
2. Enter your message and interact with the chatbot
3. All interactions are automatically logged locally under `logs/`

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

- Chat interactions are stored in `logs/chat/participant_{pid}.csv`
- Client events are stored in `logs/client/participant_{pid}.csv`
- On Render, logs are stored under `/tmp/chat_logs`

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
