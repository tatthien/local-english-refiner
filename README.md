# Local English Refiner

A TypeScript Chrome extension and local API that refine English text with a GGUF
model running directly in Node.js. Select text in an input, textarea, or
content-editable field to display a floating refinement button. The extension
streams each revision into a preview before changing the page.

<p align="center">
  <img width="635" height="368" alt="Screenshot 2026-08-26 at 22 09 32" src="https://github.com/user-attachments/assets/b7b56533-285c-459b-aed1-b90029088bbe" />
</p>

## What is included

- `backend/` - Hono TypeScript API, `node-llama-cpp` inference, and tests
- `extension/` - TypeScript source for the Manifest V3 Chrome extension
- `scripts/` - TypeScript build script
- `dist/` - generated backend and unpacked extension

The backend listens only on `127.0.0.1`. HTTP routing, middleware, and NDJSON
streaming use [Hono](https://hono.dev/) with its official Node adapter. Local
inference uses [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp)
directly, so no separate model server is required.

## 1. Install and start

Node.js 22 or newer is required:

```bash
cd ~/code/labs/ollama-english-refiner
npm install
npm run build
npm start
```

On first startup, `node-llama-cpp` downloads the default GGUF model to its
global model directory. The download must finish before the API starts. Later
starts reuse the downloaded file.

The service will be available at `http://127.0.0.1:3030`.

Test it:

```bash
curl http://127.0.0.1:3030/api/refine \
  -H 'Content-Type: application/json' \
  -d '{"text":"This sentences need to be fixed."}'
```

### Use another model

Set `MODEL` to a local GGUF path, URL, or a
[`node-llama-cpp` model URI](https://node-llama-cpp.withcat.ai/guide/downloading-models):

```bash
MODEL=/absolute/path/to/editor-model.gguf npm start
```

Supported environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `MODEL` | `hf:bartowski/google_gemma-3-12b-it-GGUF:Q4_K_M` | GGUF path, URL, or model URI |
| `CONTEXT_SIZE` | `8192` | Context window in tokens |
| `MAX_OUTPUT_TOKENS` | `1024` | Maximum generated tokens per revision |
| `INFERENCE_TIMEOUT_MS` | `120000` | Generation timeout after model loading |
| `PORT` | `3030` | Backend port |
| `HOST` | `127.0.0.1` | Backend listening address |
| `MAX_INPUT_CHARACTERS` | `20000` | Maximum accepted text length |

## 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `~/code/labs/ollama-english-refiner/dist/extension`.
5. Refresh any already-open webpages where you want to use the extension.

The extension cannot run on protected Chrome pages such as
`chrome://extensions` or the Chrome Web Store.

## Using it

1. Select the text you want to refine.
2. Click the green sparkle button beside the selection.
3. Review the revision as it streams from the local model.
4. Click **Apply** to replace exactly the selected text or **Copy** to copy it.

The preview includes the model's generation rate and total response time.

## Development checks

```bash
npm run check
npm test
npm run build
```

For automatic backend restarts during development:

```bash
npm run dev
```

## API

### `POST /api/refine`

Request:

```json
{
  "text": "Text to revise"
}
```

Response:

```json
{
  "refined": "Revised text",
  "model": "hf:bartowski/google_gemma-3-12b-it-GGUF:Q4_K_M",
  "metrics": {
    "totalDurationMs": 2500,
    "promptTokens": 40,
    "outputTokens": 20,
    "outputTokensPerSecond": 8
  }
}
```

### `GET /health`

Returns the service status and configured model.

### `POST /api/refine/stream`

Accepts the same request as `/api/refine` and returns newline-delimited JSON.
The extension uses this endpoint so text appears chunk by chunk:

```jsonl
{"type":"start","model":"hf:bartowski/google_gemma-3-12b-it-GGUF:Q4_K_M"}
{"type":"delta","delta":"Revised"}
{"type":"delta","delta":" text"}
{"type":"done","refined":"Revised text","model":"hf:bartowski/google_gemma-3-12b-it-GGUF:Q4_K_M","metrics":{}}
```
