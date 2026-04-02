# webpagestreamer

A Docker container that captures any web page and streams it as MPEG-TS. Uses a Chrome extension to capture audio and video directly from Chromium's rendering pipeline — no Xvfb, x11grab, or PulseAudio required.

Inspired by [smallbraineng/webstreamer](https://github.com/smallbraineng/webstreamer), but outputs MPEG-TS to a configurable destination instead of streaming to Twitch over RTMP.

## How it works

```
Chromium (headless, with capture extension)
    │
    ├── Content script captures tab via chrome.tabCapture API
    │   └── MediaRecorder encodes to WebM (VP8 + Opus)
    │
    └── WebSocket ──► Relay server (Node.js)
                          │
                          └── FFmpeg (H.264 + AAC ──► MPEG-TS)
                                  │
                                  └── UDP / TCP output
```

1. **Chromium** launches headless with a built-in extension that captures the active tab's audio and video using `chrome.tabCapture`
2. The **content script** records the media stream as WebM and sends chunks over WebSocket to a local relay server
3. The **relay server** (Node.js) pipes the WebM data into **FFmpeg**, which transcodes to H.264/AAC and outputs MPEG-TS
4. **Supervisord** manages all processes (relay, Chrome, capture trigger) and restarts them on failure

## Quick start

```bash
docker build -t webpagestreamer .

# Stream a webpage to UDP multicast
docker run --rm \
  -e URL="https://example.com" \
  -e OUTPUT="udp://239.0.0.1:1234?pkt_size=1316" \
  webpagestreamer
```

### Test script

The easiest way to verify everything works:

```bash
./test.sh                           # Builds, runs with TCP output, shows connection info
URL="https://example.com" ./test.sh # Custom URL
DURATION=60 ./test.sh               # Run for 60s instead of default 30s
```

Then connect from another terminal with `ffplay tcp://127.0.0.1:5000` or VLC.

### Using docker-compose

```bash
# Edit docker-compose.yml to set your URL and output, then:
docker compose up --build
```

## Environment variables

| Variable    | Default                                    | Description                              |
|-------------|--------------------------------------------|------------------------------------------|
| `URL`       | `https://www.google.com`                   | Web page to capture                      |
| `OUTPUT`    | `udp://239.0.0.1:1234?pkt_size=1316`      | FFmpeg output destination                |
| `WIDTH`     | `720`                                      | Capture width in pixels                  |
| `HEIGHT`    | `576`                                      | Capture height in pixels (PAL: 576)      |
| `FRAMERATE` | `25`                                       | Frames per second (PAL: 25)              |
| `WS_PORT`   | `9000`                                     | Internal WebSocket relay port            |
| `CDP_PORT`  | `9222`                                     | Chrome DevTools Protocol port            |

## Output examples

The `OUTPUT` variable accepts any valid FFmpeg output string:

```bash
# UDP multicast
-e OUTPUT="udp://239.0.0.1:1234?pkt_size=1316"

# UDP unicast
-e OUTPUT="udp://192.168.1.100:5000?pkt_size=1316"

# TCP listener (FFmpeg listens, clients connect)
-e OUTPUT="tcp://0.0.0.0:5000?listen=1"

# Write to file (useful for testing)
-e OUTPUT="/tmp/output.ts"
```

For TCP output, remember to expose the port:

```bash
docker run --rm -p 5000:5000 \
  -e URL="https://example.com" \
  -e OUTPUT="tcp://0.0.0.0:5000?listen=1" \
  webpagestreamer
```

## FFmpeg encoding settings

- **Video**: H.264 (libx264), ultrafast preset, zerolatency tune, 2 Mbps, High profile
- **Audio**: AAC, 128 kbps, 48 kHz stereo
- **Container**: MPEG-TS (mpegts)
- **GOP**: 2 seconds (2 x framerate)
- **Pixel format**: yuv420p

## Project structure

```
├── Dockerfile              # Alpine-based container image
├── docker-compose.yml      # Compose file for easy local usage
├── test.sh                 # Quick test: builds and streams over TCP
├── start.sh                # Entrypoint: configures and launches supervisord
├── supervisord.conf        # Process manager for relay, Chrome, and trigger
├── trigger-capture.sh      # Uses CDP to tell the extension to start capturing
├── relay/
│   ├── server.js           # WebSocket server that pipes data to FFmpeg
│   └── package.json
└── extension/
    ├── manifest.json        # Chrome extension manifest (Manifest V3)
    ├── background.js        # Gets tabCapture stream ID
    └── content.js           # Captures media stream, sends via WebSocket
```

## Troubleshooting

**Container starts but no output stream**
- Check logs with `docker logs <container>` — look for `[trigger]` and `[capture]` messages
- The trigger script waits up to 60 seconds for Chrome CDP, then retries on failure
- Ensure the output destination is reachable from inside the container

**High latency**
- The MediaRecorder uses a 20ms timeslice for low latency
- FFmpeg uses `ultrafast` preset and `zerolatency` tune
- Network conditions between the container and receiver affect end-to-end latency

**Multicast not working**
- Docker's default bridge network may not route multicast — use `--network host` if needed
- Check that your network infrastructure supports multicast

## License

MIT
