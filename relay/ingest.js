// Wire protocol:
//   ws://host:PORT/ingest/video?w=<W>&h=<H>&fr=<FR>
//     each binary message = one raw I420 frame (W*H*3/2 bytes), planes Y U V
//   ws://host:PORT/ingest/audio?sr=<SR>&ch=<CH>
//     each binary message = raw f32le interleaved PCM, variable length
//   ws://host:PORT/ingest/webm
//     each binary message = fragment of a single WebM bytestream (MediaRecorder)
//
// Video validates against the relay's resolved profile. Audio uses the
// sample rate and channel count reported by Chrome's first AudioData chunk;
// the relay must configure ffmpeg from those params before accepting either
// WebSocket handshake.

const { WebSocketServer } = require("ws");

const WS_OPEN = 1;
const backpressureLogTimes = new Map();

function logBackpressure(label) {
  const now = Date.now();
  const last = backpressureLogTimes.get(label) || 0;
  if (now - last < 1000) return;
  backpressureLogTimes.set(label, now);
  console.log(`[ingest] paused ${label} websocket for sink backpressure`);
}

function writeWithBackpressure(ws, sink, data, label) {
  const ok = sink.write(data);
  if (ok !== false || !ws._socket || ws._socket.isPaused() || typeof sink.once !== "function") return;

  ws._socket.pause();
  sink.once("drain", () => {
    if (ws.readyState === WS_OPEN && ws._socket) {
      ws._socket.resume();
    }
  });
  logBackpressure(label);
}

function validAudioParams(sampleRate, channels) {
  return (
    Number.isInteger(sampleRate) &&
    sampleRate >= 8000 &&
    sampleRate <= 192000 &&
    Number.isInteger(channels) &&
    channels >= 1 &&
    channels <= 8
  );
}

function rejectUpgrade(socket, statusCode, message) {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${statusCode} ${message}\r\n\r\n`);
  }
  socket.destroy();
}

async function runBeforeUpgrade(name, socket, hook, params) {
  if (!hook) return true;
  try {
    await hook(params);
    return true;
  } catch (e) {
    console.warn(`[ingest] ${name} upgrade setup failed: ${e.message}`);
    rejectUpgrade(socket, 503, "Service Unavailable");
    return false;
  }
}

function mountIngest(httpServer, {
  videoSink,
  audioSink,
  expected,
  onVideoConnect,
  onAudioConnect,
  onVideoParams,
  onAudioParams,
}) {
  const wssVideo = new WebSocketServer({ noServer: true });
  const wssAudio = new WebSocketServer({ noServer: true });

  wssVideo.on("connection", (ws) => {
    console.log("[ingest] video client connected");
    if (onVideoConnect) onVideoConnect(true);
    ws.on("message", (data) => writeWithBackpressure(ws, videoSink, data, "video"));
    ws.on("close", () => {
      console.log("[ingest] video client disconnected");
      if (onVideoConnect) onVideoConnect(false);
    });
    ws.on("error", (e) => console.warn("[ingest] video error:", e.message));
  });

  wssAudio.on("connection", (ws) => {
    console.log("[ingest] audio client connected");
    if (onAudioConnect) onAudioConnect(true);
    ws.on("message", (data) => writeWithBackpressure(ws, audioSink, data, "audio"));
    ws.on("close", () => {
      console.log("[ingest] audio client disconnected");
      if (onAudioConnect) onAudioConnect(false);
    });
    ws.on("error", (e) => console.warn("[ingest] audio error:", e.message));
  });

  httpServer.on("upgrade", async (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url, "ws://127.0.0.1");
    if (pathname === "/ingest/video") {
      const w = parseInt(searchParams.get("w"), 10);
      const h = parseInt(searchParams.get("h"), 10);
      const fr = parseFloat(searchParams.get("fr"));
      if (w !== expected.width || h !== expected.height || fr !== expected.framerate) {
        console.warn(`[ingest] rejecting video upgrade: got ${w}x${h}@${fr} expected ${expected.width}x${expected.height}@${expected.framerate}`);
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      const ok = await runBeforeUpgrade("video", socket, onVideoParams, { width: w, height: h, framerate: fr });
      if (!ok || socket.destroyed) {
        return;
      }
      wssVideo.handleUpgrade(req, socket, head, (ws) => wssVideo.emit("connection", ws, req));
      return;
    }
    if (pathname === "/ingest/audio") {
      const sr = parseInt(searchParams.get("sr"), 10);
      const ch = parseInt(searchParams.get("ch"), 10);
      if (!validAudioParams(sr, ch)) {
        console.warn(`[ingest] rejecting audio upgrade: got ${sr}Hz×${ch}`);
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      const ok = await runBeforeUpgrade("audio", socket, onAudioParams, { sampleRate: sr, channels: ch });
      if (!ok || socket.destroyed) {
        return;
      }
      wssAudio.handleUpgrade(req, socket, head, (ws) => wssAudio.emit("connection", ws, req));
      return;
    }
    // Other upgrades are not ours — let the default handler 404 by destroying.
    socket.destroy();
  });
}

function mountIngestWebm(httpServer, {
  streamSink,
  onStreamConnect,
  onBeforeUpgrade,
  onNoActiveClients,
}) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    console.log("[ingest] webm client connected");
    if (onStreamConnect) onStreamConnect(true);
    ws.on("message", (data) => writeWithBackpressure(ws, streamSink, data, "webm"));
    ws.on("close", () => {
      console.log("[ingest] webm client disconnected");
      if (onStreamConnect) onStreamConnect(false);
      // A new client may already be connected; do not tear down FFmpeg on a
      // stale socket close from the previous session.
      setImmediate(() => {
        if (wss.clients.size === 0 && onNoActiveClients) {
          onNoActiveClients();
        }
      });
    });
    ws.on("error", (e) => console.warn("[ingest] webm error:", e.message));
  });

  httpServer.on("upgrade", async (req, socket, head) => {
    const { pathname } = new URL(req.url, "ws://127.0.0.1");
    if (pathname !== "/ingest/webm") {
      socket.destroy();
      return;
    }
    const ok = await runBeforeUpgrade("webm", socket, onBeforeUpgrade, {});
    if (!ok || socket.destroyed) {
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}

module.exports = { mountIngest, mountIngestWebm };
