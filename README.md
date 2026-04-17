# webpagestreamer

A Docker container that captures any web page and streams it as MPEG-TS. Uses a Chrome extension to capture audio and video directly from Chromium's rendering pipeline — no Xvfb, x11grab, or PulseAudio required.

Inspired by [smallbraineng/webstreamer](https://github.com/smallbraineng/webstreamer), but outputs MPEG-TS to a configurable destination instead of streaming to Twitch over RTMP.

## Breaking changes in 0.3.0

- `OUTPUT` env var has been split into `UDP_OUTPUT` and `HTTP_OUTPUT=true|false`.
  Both can be enabled simultaneously.
- `WS_PORT` has been renamed to `HTTP_PORT` (the WebSocket server is gone).
  `WS_PORT` is still accepted as a silent fallback for one release.
- `rtp://`, `tcp://`, and file output schemes have been removed. If you need
  them, stay on 0.2.x.
- The ingest pipeline is now WebRTC → mediamtx → FFmpeg, which fixes long-
  running A/V drift. See `docs/plans/2026-04-17-av-drift-webrtc-rebuild-design.md`.

## How it works

```
Chromium (headless, with capture extension)
    │
    ├── Content script captures tab via chrome.tabCapture API
    │   └── RTCPeerConnection sends WebRTC (VP8 + Opus)
    │
    └── WHIP ──► mediamtx (WebRTC ingest)
                    │
                    └── FFmpeg (MPEG-2 + MP2 ──► MPEG-TS)
                            │
                            ├── HTTP /stream.ts
                            └── UDP multicast
```

1. **Chromium** launches headless with a built-in extension that captures the active tab's audio and video using `chrome.tabCapture`
2. The **content script** sends the media stream to **mediamtx** via WHIP (WebRTC ingest)
3. The **relay server** (Node.js) reads the RTSP output from mediamtx and pipes it into **FFmpeg**, which transcodes to MPEG-2/MP2 MPEG-TS
4. FFmpeg writes to the configured destinations (`HTTP_OUTPUT`, `UDP_OUTPUT`, or both)
5. **Supervisord** manages all processes (relay, Chrome, mediamtx, capture trigger) and restarts them on failure

## Quick start

```bash
docker build -t webpagestreamer .

docker run --rm -p 9000:9000 \
  -e URL="https://example.com" \
  -e HTTP_OUTPUT=true \
  -e HTTP_PORT=9000 \
  webpagestreamer
# Then: ffplay -f mpegts http://127.0.0.1:9000/stream.ts
```

### Test script

The easiest way to verify everything works:

```bash
./test.sh                           # Builds, runs with HTTP output, shows connection info
URL="https://example.com" ./test.sh # Custom URL
DURATION=60 ./test.sh               # Run for 60s instead of default 30s
```

Then connect from another terminal with `ffplay -f mpegts http://127.0.0.1:9000/stream.ts` or VLC.

### Using docker-compose

```bash
# Edit docker-compose.yml to set your URL and output, then:
docker compose up --build
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `URL` | `https://www.google.com` | Page to capture |
| `PROFILE` | `pal` | Encoding profile (`pal`, `ntsc`, `720p`, `1080p`, `hls`) |
| `UDP_OUTPUT` | `udp://239.0.0.1:1234` | UDP multicast destination. Empty string disables. |
| `HTTP_OUTPUT` | `true` | If `true`, serve progressive MPEG-TS at `/stream.ts`. |
| `HTTP_PORT` | `9000` | Port the relay listens on. |
| `WIDTH`/`HEIGHT`/`FRAMERATE` | profile defaults | Overrides |
| `VIDEO_CODEC`/`AUDIO_CODEC`/`VIDEO_BITRATE`/`AUDIO_BITRATE`/`SAR`/`INTERLACED`/`FORMAT` | profile defaults | Overrides |
| `CHANNEL_NAME`/`CHANNEL_ID`/`PROGRAMME_TITLE`/`PROGRAMME_DESC`/`STREAM_URL` | — | IPTV metadata |
| `CDP_PORT` | `9222` | Chromium remote debugging port (internal) |

## Output destinations

### HTTP (progressive MPEG-TS)

The stream is served at `/stream.ts` on `HTTP_PORT` (default 9000). Multiple clients can connect simultaneously; low latency (~200-500 ms).

```bash
docker run --rm -p 9000:9000 \
  -e URL="https://example.com" \
  -e HTTP_OUTPUT=true \
  -e HTTP_PORT=9000 \
  webpagestreamer

# Connect with any MPEG-TS client:
ffplay -f mpegts http://127.0.0.1:9000/stream.ts
vlc http://127.0.0.1:9000/stream.ts
# Also works in <video> tags, IPTV frontends, xTeVe, Tvheadend, etc.
# The /playlist.m3u endpoint advertises this URL automatically.
```

For an HLS (segmented) alternative, set `PROFILE=hls` — segments are served on the same port at `http://<host>:9000/stream/stream.m3u8`.

### UDP unicast / multicast

Best for production use where you need to feed an IPTV headend, hardware decoder, or network receiver.

```bash
# Unicast to a specific host
docker run --rm \
  -e URL="https://example.com" \
  -e UDP_OUTPUT="udp://192.168.1.100:1234" \
  webpagestreamer

# Multicast (requires --network host on Linux; does NOT work on macOS Docker)
docker run --rm --network host \
  -e URL="https://example.com" \
  -e UDP_OUTPUT="udp://239.0.0.1:1234" \
  webpagestreamer
```

> **Note:** UDP multicast does not work from Docker on macOS because Docker Desktop runs inside a Linux VM that doesn't route multicast to the host. Use HTTP output for local testing on Mac, or `--network host` on a Linux host.

Both `UDP_OUTPUT` and `HTTP_OUTPUT` can be set simultaneously.

## FFmpeg encoding settings

- **Video**: MPEG-2 (mpeg2video), 5 Mbps, interlaced flags, SAR 12:11 (PAL 4:3)
- **Audio**: MPEG-2 Layer 2 (MP2), 256 kbps, 48 kHz stereo
- **Container**: MPEG-TS (mpegts)
- **GOP**: 0.5 seconds (fast channel joining)
- **Pixel format**: yuv420p

## Project structure

```
├── Dockerfile              # Alpine-based container image
├── docker-compose.yml      # Compose file for easy local usage
├── test.sh                 # Quick test: builds and streams over HTTP
├── start.sh                # Entrypoint: configures and launches supervisord
├── supervisord.conf        # Process manager for relay, Chrome, and trigger
├── trigger-capture.sh      # Uses CDP to tell the extension to start capturing
├── relay/
│   ├── server.js           # RTSP (mediamtx) → FFmpeg → HTTP/UDP output
│   └── package.json
└── extension/
    ├── manifest.json        # Chrome extension manifest (Manifest V3)
    ├── background.js        # Gets tabCapture stream ID
    └── content.js           # Captures media stream, sends via WHIP/WebRTC
```

## Troubleshooting

**Container starts but no output stream**
- Check logs with `docker logs <container>` — look for `[trigger]`, `[capture]`, and `[relay]` messages
- The trigger script waits up to 60 seconds for Chrome CDP, then retries on failure
- For HTTP output, verify you can reach the stream: `curl -I http://127.0.0.1:9000/stream.ts`

**High latency**
- The WebRTC pipeline is tuned for low latency; typical end-to-end is ~200-500 ms
- Network conditions between the container and receiver affect end-to-end latency

**HTTP URLs fail to capture (tabCapture error)**
- Chrome's `tabCapture` API requires HTTPS. The container automatically allows insecure origins for `http://` URLs via `--unsafely-treat-insecure-origin-as-secure`
- Content script also hides scrollbars and Chrome media overlay icons

**UDP multicast not working**
- Does not work on macOS Docker — use HTTP output (`HTTP_OUTPUT=true`) for local testing
- On Linux, use `--network host` to allow multicast routing
- Check that your network infrastructure supports multicast (IGMP snooping, etc.)

**Accessing a local dev server from the container**
- Use `host.docker.internal` instead of `localhost`:
  ```bash
  -e URL="http://host.docker.internal:3000"
  ```

## Measuring A/V drift

Start the container pointed at the bundled test clock page and record the
UDP output for 60 minutes:

```bash
docker run --rm -p 9000:9000 \
  -e URL="http://127.0.0.1:9000/test/clock.html" \
  -e UDP_OUTPUT="udp://239.0.0.1:1234" \
  -e HTTP_OUTPUT=true \
  webpagestreamer
```

In another shell:

```bash
ffmpeg -i udp://@239.0.0.1:1234 -t 3600 -c copy drift-test.ts
```

Open `drift-test.ts` in ffplay or VLC and spot-check that the on-screen
clock and the audio beeps stay aligned throughout (±40 ms at t=0, 30 min,
60 min is the success bar).

## License

MIT
