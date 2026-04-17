#!/bin/bash
# Waits for Chrome to be ready, then uses CDP to trigger capture
# by posting a CAPTURE_COMMAND message to the page via JavaScript evaluation.

set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
HTTP_PORT="${HTTP_PORT:-9000}"
WIDTH="${WIDTH:-720}"
HEIGHT="${HEIGHT:-576}"
FRAMERATE="${FRAMERATE:-25}"
WHIP_URL="${WHIP_URL:-http://127.0.0.1:8889/live/whip}"

echo "[trigger] waiting for Chrome CDP on port $CDP_PORT..."

for i in $(seq 1 60); do
    if curl -s "http://127.0.0.1:${CDP_PORT}/json" > /dev/null 2>&1; then
        echo "[trigger] Chrome CDP is ready"
        break
    fi
    if [ "$i" = "60" ]; then
        echo "[trigger] ERROR: Chrome did not start within 60s"
        exit 1
    fi
    sleep 1
done

sleep 3

WS_URL=$(curl -s "http://127.0.0.1:${CDP_PORT}/json" | python3 -c "
import sys, json
tabs = json.load(sys.stdin)
for tab in tabs:
    if tab.get('type') == 'page':
        print(tab['webSocketDebuggerUrl'])
        break
")

if [ -z "$WS_URL" ]; then
    echo "[trigger] ERROR: no page tab found"
    exit 1
fi

echo "[trigger] found tab: $WS_URL"
echo "[trigger] setting viewport to ${WIDTH}x${HEIGHT}..."

python3 <<PYEOF
import json, asyncio, websockets

async def trigger():
    ws_url = "${WS_URL}"
    async with websockets.connect(ws_url, max_size=None) as ws:
        metrics_cmd = {
            "id": 1,
            "method": "Emulation.setDeviceMetricsOverride",
            "params": {
                "width": ${WIDTH},
                "height": ${HEIGHT},
                "deviceScaleFactor": 1,
                "mobile": False
            }
        }
        await ws.send(json.dumps(metrics_cmd))
        resp = await ws.recv()
        print("[trigger] viewport set:", resp)

        cmd = {
            "id": 2,
            "method": "Runtime.evaluate",
            "params": {
                "expression": """
                    window.postMessage({
                        type: 'CAPTURE_COMMAND',
                        command: 'start',
                        whipUrl: '${WHIP_URL}',
                        width: ${WIDTH},
                        height: ${HEIGHT},
                        framerate: ${FRAMERATE}
                    }, '*');
                    'capture triggered';
                """,
                "returnByValue": True
            }
        }
        await ws.send(json.dumps(cmd))
        resp = await ws.recv()
        print("[trigger] CDP response:", resp)
        print("[trigger] capture command sent successfully")

asyncio.run(trigger())
PYEOF
