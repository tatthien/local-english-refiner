# Local English Refiner

A TypeScript Chrome extension and local API that refine English text with Ollama. The extension adds a floating button to text inputs, textareas, and content-editable fields. It streams each revision into a preview before changing the page.

## What is included

- `backend/` — TypeScript Node API with a predefined editing prompt
- `extension/` — TypeScript source for the Manifest V3 Chrome extension
- `scripts/` — TypeScript build script
- `test/` — TypeScript integration tests using a mock Ollama server
- `work/` — TypeScript-powered page for manually testing the extension UI
- `dist/` — generated backend, unpacked extension, and test page

The backend listens only on `127.0.0.1`. Text generation and streaming use [Vercel AI SDK](https://ai-sdk.dev/) with [`ollama-ai-provider-v2`](https://ai-sdk.dev/providers/community-providers/ollama), and every request disables model thinking.

## 1. Start Ollama

The default model is `gemma4:26b-mlx`, which is already installed on this Mac.

Confirm that Ollama is available:

```bash
ollama list
```

To use a different installed model, set `OLLAMA_MODEL` when starting the backend.

## 2. Start the backend

Node.js 22 or newer is required. Install dependencies and build the project once:

```bash
cd ~/code/labs/ollama-english-refiner
npm install
npm run build
npm start
```

The service will be available at `http://127.0.0.1:3030`.

Test it:

```bash
curl http://127.0.0.1:3030/api/refine \
  -H 'Content-Type: application/json' \
  -d '{"text":"This sentences need to be fixed."}'
```

### Configuration

```bash
OLLAMA_MODEL=gemma4:12b-mlx npm start
```

Supported environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `OLLAMA_MODEL` | `gemma4:26b-mlx` | Ollama model name |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API address |
| `PORT` | `3030` | Backend port |
| `HOST` | `127.0.0.1` | Backend listening address |
| `OLLAMA_TIMEOUT_MS` | `120000` | Ollama request timeout |
| `MAX_INPUT_CHARACTERS` | `20000` | Maximum accepted text length |

## 3. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `~/code/labs/ollama-english-refiner/dist/extension`.
5. Refresh any already-open webpages where you want to use the extension.

The extension cannot run on protected Chrome pages such as `chrome://extensions` or the Chrome Web Store.

## Using it

1. Focus a text input, textarea, or content-editable field.
2. Optionally select only the text you want to refine.
3. Click the green sparkle button at the lower-right edge of the field.
4. Review the result as it streams from Ollama.
5. Click **Apply** to replace the original text or **Copy** to copy it.

The preview includes the model's generation rate and total response time when Ollama reports them.

## Development checks

```bash
npm run check
npm test
npm run build
```

For a manual UI test, keep the backend running and open
`dist/work/test-page.html` directly, or serve the generated directory:

```bash
cd dist
python3 -m http.server 4173 --bind 127.0.0.1
```

Then visit `http://127.0.0.1:4173/work/test-page.html`. Run `npm run build`
again after changing extension or test-page TypeScript.

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
  "model": "gemma4:26b-mlx",
  "metrics": {
    "totalDurationMs": 2500,
    "promptTokens": 40,
    "outputTokens": 20,
    "outputTokensPerSecond": 25
  }
}
```

### `GET /health`

Returns the configured model and Ollama address.

### `POST /api/refine/stream`

Accepts the same request as `/api/refine` and returns newline-delimited JSON.
The extension uses this endpoint so text appears token by token. The backend
generates these deltas through AI SDK's `streamText` API:

```jsonl
{"type":"start","model":"gemma4:26b-mlx"}
{"type":"delta","delta":"Revised"}
{"type":"delta","delta":" text"}
{"type":"done","refined":"Revised text","model":"gemma4:26b-mlx","metrics":{}}
```
