# Local English Refiner

A TypeScript Chrome extension and local API that refine English text with a GGUF
model running directly in Node.js. Select text in an input, textarea, or
content-editable field to display a floating refinement button. The extension
streams each revision into a preview before changing the page.

<p align="center">
  <img width="624" height="407" alt="Screenshot 2026-10-22 at 23 13 32" src="https://github.com/user-attachments/assets/ad484694-3b4a-49e0-aa2f-36f1a9e5086b" />
</p>


## What is included

- `backend/` - Hono TypeScript API, `node-llama-cpp` inference, and tests
- `extension/` - TypeScript source for the Manifest V3 Chrome extension
- `native-host/` - Chrome native messaging host that starts the backend on demand
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
| `MODEL` | `hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M` | GGUF path, URL, or model URI |
| `CONTEXT_SIZE` | `8192` | Context window in tokens |
| `MAX_OUTPUT_TOKENS` | `1024` | Maximum generated tokens per revision |
| `INFERENCE_TIMEOUT_MS` | `120000` | Generation timeout after model loading |
| `PORT` | `3030` | Backend port |
| `HOST` | `127.0.0.1` | Backend listening address |
| `MAX_INPUT_CHARACTERS` | `20000` | Maximum accepted text length |
| `IDLE_TIMEOUT_MS` | `0` | Stop after this many milliseconds with no requests (`0` disables it) |
| `LOG_LEVEL` | `info` | Minimum JSON log level: `debug`, `info`, `warn`, or `error` |

### Run in the background with PM2

On macOS, PM2 can keep the native Metal-accelerated backend running in the
background and restart it after a crash. Install PM2, build the project, and
start exactly one backend process:

```bash
npm install --global pm2
npm run build

NODE_BIN="$(realpath "$(command -v node)")"
MODEL='hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M' \
pm2 start dist/backend/server.js \
  --name local-english-refiner \
  --execute-command \
  --interpreter "$NODE_BIN"
```

`--execute-command` forces PM2 fork mode, while `--interpreter` ensures PM2 uses
the active Node.js version when multiple version managers are installed.
`realpath` resolves version-manager shell links to a stable executable for PM2
startup. Confirm that `pm2 describe local-english-refiner` reports `fork_mode`
and Node.js 22 or newer. Do not use PM2 cluster mode or `--instances`; every
process would load its own copy of the model and consume additional memory.

Useful management commands:

```bash
pm2 status
pm2 logs local-english-refiner
pm2 restart local-english-refiner
pm2 stop local-english-refiner
pm2 delete local-english-refiner
```

When changing environment variables, restart with `--update-env`:

```bash
MODEL='hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M' \
pm2 restart local-english-refiner --update-env
```

To restore the backend automatically after logging in or restarting macOS:

```bash
pm2 startup
```

Run the setup command printed by PM2, then save the current process list:

```bash
pm2 save
```

### Start on demand from Chrome

The extension can start the backend when you click the refinement button. If
the backend does not respond, the extension calls a native messaging host. The
host starts `dist/backend/server.js` in the background and waits until the
model is loaded.

Install the host one time:

```bash
npm run build
npm run install-host
```

The script writes two files to
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (or
`~/.config/google-chrome/NativeMessagingHosts/` on Linux):

- `local_english_refiner.json` - the host manifest for the extension ID
- `local_english_refiner.sh` - a wrapper that runs the host with the current Node.js binary

Chrome starts the host with a minimal `PATH`, so the wrapper records the
absolute path of Node.js. If you change or remove that Node.js version, run
`npm run install-host` again.

A backend started by the host stops after 30 minutes with no requests, so the
model does not keep its memory. The next click starts it again. Set
`IDLE_TIMEOUT_MS` before you install the host to change this value. The host
writes the backend logs to `~/.local-english-refiner/server.log`.

To remove the host:

```bash
npm run uninstall-host
```

If PM2 or `npm start` already runs the backend, the extension uses it and the
host does not start a second copy.

## 2. Start with Docker

Docker Compose builds and starts the backend without requiring a local Node.js
installation:

```bash
docker compose up --build
```

The API is available at `http://127.0.0.1:3030`. The first startup downloads
the configured model before the API becomes healthy. A named Docker volume
stores the model so subsequent containers reuse it.

Override the model or host port through environment variables:

```bash
MODEL='hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M' \
API_PORT=3031 \
docker compose up --build
```

For a persistent model selection, create a `.env` file beside
`docker-compose.yml`:

```dotenv
MODEL=hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M
CONTEXT_SIZE=4096
```

Then recreate the service. Changing the model does not require rebuilding the
image:

```bash
docker compose up -d
```

Check the resolved model and other Compose settings with:

```bash
docker compose config
```

The selected model is downloaded on first startup and retained in the
`model-cache` volume.

Run in the background and inspect the Pino logs:

```bash
docker compose up --build -d
docker compose logs -f api
```

Stop the service without deleting the downloaded model:

```bash
docker compose down
```

To delete the service and model volume, run `docker compose down --volumes`.
The included image uses CPU inference. Docker Desktop on macOS does not expose
Apple Metal acceleration to Linux containers, so running through Node.js
directly is faster on Apple Silicon.

## 3. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `~/code/labs/ollama-english-refiner/dist/extension`.
5. Refresh any already-open webpages where you want to use the extension.

The `key` in `extension/manifest.json` gives the extension a fixed ID. The
native host accepts only this ID. If you loaded the extension before the `key`
was added, remove it and load it again.

The extension cannot run on protected Chrome pages such as
`chrome://extensions` or the Chrome Web Store.

## Using it

1. Select the text you want to refine.
2. Click the orange face button beside the selection. Its eyes follow the pointer, and they roll while the text is refined.
3. Review highlighted additions and removals in **Changes**, or switch between
   the **Refined** and **Original** views.
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

### Logging

Backend logs use [Pino](https://getpino.io/) and are emitted as newline-delimited
JSON so they can be searched or ingested by logging tools. Set `LOG_LEVEL=debug`
for inference-start details. Logs include
request IDs, durations, status codes, token usage, and serialized errors. Input
text is never logged; only its character count is recorded.

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
  "model": "hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M",
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
{"type":"start","model":"hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M"}
{"type":"delta","delta":"Revised"}
{"type":"delta","delta":" text"}
{"type":"done","refined":"Revised text","model":"hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M","metrics":{}}
```

## Use ChatGPT instead of the local model

1. Open the extension options page (right-click the extension icon, then **Options**).
2. Click **Connect** and sign in with ChatGPT in the new tab.
3. Set **Use** to **ChatGPT (OpenAI)**.

The sign-in uses the public Codex CLI client ID and the undocumented ChatGPT Codex backend. OpenAI can change or block it at any time. The tokens stay on your machine: the macOS keychain on macOS, or a file with mode `0600` on other systems. The extension never holds the tokens.
