#!/bin/bash
python -m uvicorn delay_C_Test:app --host 0.0.0.0 --port $PORT --timeout-keep-alive 300 --timeout-graceful-shutdown 30
