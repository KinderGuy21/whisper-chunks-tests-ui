# React Audio Chunker POC

Minimal static React app to record audio, emit timed chunks with optional overlap, and POST them to your Nest backend.

## What it does
- Uses `MediaRecorder` to capture mic audio (webm/opus) and deliver chunks every N milliseconds (default 60,000).
- Optionally prepends a short overlap tail from the previous chunk (default 2,000 ms, approximate by bytes).
- Sends `multipart/form-data` to `POST {BACKEND}/upload-chunk` with fields: `file`, `sessionId`, `seq`, `startMs`, `endMs`.
- Has a `Finalize` button that POSTs `{BACKEND}/finalize` with `{ sessionId }`.

## Run locally
```bash
npm install
npm run dev
# open http://localhost:5173
```

Set your backend base URL in the UI (defaults to http://localhost:3000).

## Build static
```bash
npm run build
npm run preview
```

Or serve `dist/` with any static server.

## Notes
- Microphone access requires HTTPS or `http://localhost`.
- The overlap uses a bytes ratio heuristic. It is sufficient for a POC. Your backend dedupe will still handle boundaries.
- If the browser does not support `audio/webm;codecs=opus`, the app lets the browser pick a supported mime type automatically.