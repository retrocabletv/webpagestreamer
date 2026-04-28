# AGENTS.md

## Project overview

webpagestreamer is a Docker container that captures a web page from headless Chromium and streams it as MPEG-TS. It uses Chrome's `tabCapture` API via a built-in extension — not Xvfb or PulseAudio.

## Architecture

Three processes run inside the container, managed by supervisord:

1. **Relay server** (`relay/server.js`) — Node.js HTTP/WebSocket server. **Default (`INGEST_MODE=webm`):** accepts a muxed **WebM** bytestream on `WS /ingest/webm` and writes it to **FFmpeg stdin**; FFmpeg encodes to MPEG-TS and writes to `OUTPUT` directly (UDP/RTP/TCP/file). **Legacy (`INGEST_MODE=raw`):** accepts separate **I420 + f32le PCM** sockets and uses named pipes into FFmpeg. Starts first (priority 10).

2. **Chrome** (`start.sh` generates `/tmp/launch-chrome.sh`) — Headless Chromium with the capture extension loaded. Navigates to the configured URL. Starts second (priority 20).

3. **Trigger** (`trigger-capture.sh`) — One-shot script that waits for Chrome's CDP port, then sends a `Runtime.evaluate` command via WebSocket to post a `CAPTURE_COMMAND` message to the page, which the content script listens for. The message includes `captureMode` (default `webm`, must match relay `INGEST_MODE`). Starts last (priority 30). Retries on unexpected failure.

## Data flow (default)

```
Chrome tab → content.js (MediaRecorder → WebM chunks) → ws://…/ingest/webm
    → relay writes FFmpeg stdin → FFmpeg → MPEG-TS → OUTPUT
```

Legacy raw mode (explicit `INGEST_MODE=raw` + `CAPTURE_MODE=raw`):

```
Chrome tab → content.js (MediaStreamTrackProcessor: I420 + PCM) → /ingest/video + /ingest/audio
    → named pipes → FFmpeg → MPEG-TS → OUTPUT
```

Raw mode does **not** share a muxed timeline between audio and video; it can drift under load. Prefer WebM for A/V sync.

## Key files

- `Dockerfile` — Single-stage Alpine image. Installs Chromium, FFmpeg, Node.js, supervisor, Python3 + websockets.
- `start.sh` — Entrypoint. Sets defaults (including `INGEST_MODE` / `CAPTURE_MODE`), generates the Chrome launch script, exports env vars, starts supervisord.
- `supervisord.conf` — Manages relay, chrome, and trigger. Passes `INGEST_MODE` to relay and `CAPTURE_MODE` to trigger.
- `trigger-capture.sh` — CDP `Runtime.evaluate` posts `CAPTURE_COMMAND` with `captureMode`.
- `relay/server.js` — Spawns FFmpeg; WebM or raw ingest per `INGEST_MODE`. FFmpeg opens `OUTPUT` natively (not proxied by Node for media).
- `relay/ingest.js` — WebSocket upgrades: `/ingest/webm` or `/ingest/video` + `/ingest/audio`.
- `extension/content.js` — `CAPTURE_COMMAND` → tab capture → **WebM** (`MediaRecorder`, 100 ms timeslice by default) or **raw** pumps.
- `extension/manifest.json` — Manifest V3; hardcoded `key` → fixed extension ID.
- `extension/background.js` — `chrome.tabCapture.getMediaStreamId()`.

## Extension ID

The extension has a hardcoded public key in `manifest.json` which produces the fixed extension ID `akfimkeaknlnblgelnlelcgihcmconnb`. This ID is referenced in `start.sh` for the `--allowlisted-extension-id` Chrome flag. If you regenerate the key, update both files.

## Environment variables

Docker / `start.sh`: `URL`, `OUTPUT`, `WIDTH`, `HEIGHT`, `FRAMERATE`, `WS_PORT`, `CDP_PORT`, **`INGEST_MODE`** (default `webm`; `raw` for legacy), **`CAPTURE_MODE`** (defaults to same value as `INGEST_MODE`). Encoding overrides: `VIDEO_CODEC`, `AUDIO_CODEC`, `VIDEO_BITRATE`, `AUDIO_BITRATE`, `SAR`, `INTERLACED`, `B_FRAMES`. IPTV metadata: `CHANNEL_*`, `PROGRAMME_*`, `STREAM_URL`.

## Testing

```bash
docker build -t webpagestreamer .
docker run --rm -p 9876:9876 -e URL="https://example.com" \
  -e OUTPUT="tcp://0.0.0.0:9876?listen=1" webpagestreamer
# ffplay -f mpegts tcp://127.0.0.1:9876
```

Local page from the host: `-e URL="http://host.docker.internal:PORT/"`.

## Common pitfalls

- **ingest mode mismatch:** Relay and extension must agree (`INGEST_MODE` + `CAPTURE_MODE`). If only one is `raw`, the handshake will fail or stall.
- **WebM reconnect:** A new WebSocket session starts a new WebM stream; the relay restarts FFmpeg for a clean demux. Brief gap possible.
- **HTTP URLs:** `start.sh` adds `--unsafely-treat-insecure-origin-as-secure` for the page origin so `tabCapture` works.
- **Viewport:** Trigger uses `Emulation.setDeviceMetricsOverride` for exact `WIDTH`×`HEIGHT`.
- **Chrome noise in logs:** DBus, ALSA, GCM, Vulkan warnings in headless Docker are usually harmless.
- **ffplay:** Brief pitch or sync quirks can be the **player** (`-sync audio` vs `-sync video`) or TCP jitter; compare with VLC or a file recording.
- **mpeg2video:** One-time `impossible bitrate constraints` at startup may appear even when the encode is stable; output `25 fps` and steady `speed≈1` are good signs.
- Trigger uses inline Python with the `websockets` library; `python3-websockets` must be installed in the image.
