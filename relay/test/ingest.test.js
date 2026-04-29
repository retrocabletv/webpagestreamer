const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { Writable } = require("node:stream");
const WebSocket = require("ws");
const { mountIngest, mountIngestWebm } = require("../ingest.js");

function collector() {
  const chunks = [];
  return {
    sink: new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    }),
    chunks,
  };
}

test("video and audio WS messages are forwarded to their sinks in order", async () => {
  const v = collector();
  const a = collector();

  const httpServer = http.createServer();
  mountIngest(httpServer, { videoSink: v.sink, audioSink: a.sink, expected: { width: 4, height: 4, framerate: 25, sampleRate: 44100, channels: 2 } });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;

  const vws = new WebSocket(`ws://127.0.0.1:${port}/ingest/video?w=4&h=4&fr=25`);
  const aws = new WebSocket(`ws://127.0.0.1:${port}/ingest/audio?sr=44100&ch=2`);
  await Promise.all([
    new Promise((r) => vws.once("open", r)),
    new Promise((r) => aws.once("open", r)),
  ]);

  vws.send(Buffer.from([1, 2, 3]));
  vws.send(Buffer.from([4, 5, 6]));
  aws.send(Buffer.from([7, 8]));
  aws.send(Buffer.from([9, 10]));

  // Give the server a tick to flush.
  await new Promise((r) => setTimeout(r, 50));

  assert.deepStrictEqual(Buffer.concat(v.chunks), Buffer.from([1, 2, 3, 4, 5, 6]));
  assert.deepStrictEqual(Buffer.concat(a.chunks), Buffer.from([7, 8, 9, 10]));

  vws.close(); aws.close();
  await new Promise((r) => httpServer.close(r));
});

test("video WS connection is rejected on dimension mismatch", async () => {
  const v = collector();
  const a = collector();
  const httpServer = http.createServer();
  mountIngest(httpServer, { videoSink: v.sink, audioSink: a.sink, expected: { width: 720, height: 576, framerate: 25, sampleRate: 44100, channels: 2 } });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;

  const vws = new WebSocket(`ws://127.0.0.1:${port}/ingest/video?w=1280&h=720&fr=25`);
  // Suppress the post-rejection "error" event so it doesn't bubble as unhandled
  // (ws emits 'error' after 'unexpected-response' when the server destroys the socket).
  vws.on("error", () => {});
  // Server should reject the upgrade with HTTP 400 — ws emits 'unexpected-response'.
  await new Promise((r) => vws.once("unexpected-response", (_req, res) => {
    assert.strictEqual(res.statusCode, 400);
    r();
  }));

  await new Promise((r) => httpServer.close(r));
});

test("audio WS connection accepts Chrome-reported sample rate and channel count", async () => {
  const v = collector();
  const a = collector();
  let audioParams = null;
  const httpServer = http.createServer();
  mountIngest(httpServer, {
    videoSink: v.sink,
    audioSink: a.sink,
    expected: { width: 720, height: 576, framerate: 25 },
    onAudioParams(params) {
      audioParams = params;
    },
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;

  const aws = new WebSocket(`ws://127.0.0.1:${port}/ingest/audio?sr=48000&ch=2`);
  await new Promise((r) => aws.once("open", r));
  assert.deepStrictEqual(audioParams, { sampleRate: 48000, channels: 2 });

  aws.close();
  await new Promise((r) => httpServer.close(r));
});

test("audio WS connection is rejected on invalid sample rate", async () => {
  const v = collector();
  const a = collector();
  const httpServer = http.createServer();
  mountIngest(httpServer, { videoSink: v.sink, audioSink: a.sink, expected: { width: 720, height: 576, framerate: 25 } });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;

  const aws = new WebSocket(`ws://127.0.0.1:${port}/ingest/audio?sr=0&ch=2`);
  aws.on("error", () => {});
  await new Promise((r) => aws.once("unexpected-response", (_req, res) => {
    assert.strictEqual(res.statusCode, 400);
    r();
  }));

  await new Promise((r) => httpServer.close(r));
});

test("webm WS messages are forwarded to the stream sink in order", async () => {
  const c = collector();
  const httpServer = http.createServer();
  mountIngestWebm(httpServer, {
    streamSink: c.sink,
    onBeforeUpgrade: async () => {},
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest/webm`);
  await new Promise((r) => ws.once("open", r));

  ws.send(Buffer.from([1, 2, 3]));
  ws.send(Buffer.from([4, 5]));

  await new Promise((r) => setTimeout(r, 50));

  assert.deepStrictEqual(Buffer.concat(c.chunks), Buffer.from([1, 2, 3, 4, 5]));

  ws.close();
  await new Promise((r) => httpServer.close(r));
});

test("unknown ingest pathname destroys the upgrade socket", async () => {
  const v = collector();
  const a = collector();
  const httpServer = http.createServer();
  mountIngest(httpServer, { videoSink: v.sink, audioSink: a.sink, expected: { width: 720, height: 576, framerate: 25, sampleRate: 44100, channels: 2 } });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest/bogus`);
  ws.on("error", () => {});
  // socket.destroy() with no response → ws sees connection closed before handshake.
  await new Promise((r) => ws.once("close", () => r()));

  await new Promise((r) => httpServer.close(r));
});
