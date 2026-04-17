const { test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { parseUDPOutput, chunkForUDP, createHTTPFanout } = require("../outputs.js");

test("parseUDPOutput extracts host and port", () => {
  assert.deepEqual(parseUDPOutput("udp://239.0.0.1:1234"), {
    host: "239.0.0.1",
    port: 1234,
    isMulticast: true,
  });
});

test("parseUDPOutput flags non-multicast addresses correctly", () => {
  assert.deepEqual(parseUDPOutput("udp://10.0.0.5:5000"), {
    host: "10.0.0.5",
    port: 5000,
    isMulticast: false,
  });
});

test("chunkForUDP yields 1316-byte TS-aligned slices", () => {
  // 4000-byte buffer → 1316 + 1316 + 1316 + 52
  const buf = Buffer.alloc(4000, 0xab);
  const chunks = [...chunkForUDP(buf)];
  assert.equal(chunks.length, 4);
  assert.equal(chunks[0].length, 1316);
  assert.equal(chunks[1].length, 1316);
  assert.equal(chunks[2].length, 1316);
  assert.equal(chunks[3].length, 52);
});

test("chunkForUDP handles buffers smaller than one packet", () => {
  const buf = Buffer.alloc(100, 0x11);
  const chunks = [...chunkForUDP(buf)];
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 100);
});

test("chunkForUDP yields nothing for an empty buffer", () => {
  const chunks = [...chunkForUDP(Buffer.alloc(0))];
  assert.equal(chunks.length, 0);
});

test("createHTTPFanout writes to every live client", () => {
  const writes = [];
  const clients = new Set([
    { destroyed: false, writable: true, write: (c) => writes.push(["a", c]), end: () => {} },
    { destroyed: false, writable: true, write: (c) => writes.push(["b", c]), end: () => {} },
  ]);
  const sink = createHTTPFanout(clients);
  sink.write(Buffer.from("hello"));
  assert.equal(writes.length, 2);
  assert.equal(writes[0][0], "a");
  assert.equal(writes[1][0], "b");
});

test("createHTTPFanout skips destroyed or non-writable clients", () => {
  const writes = [];
  const clients = new Set([
    { destroyed: true, writable: true, write: (c) => writes.push(c), end: () => {} },
    { destroyed: false, writable: false, write: (c) => writes.push(c), end: () => {} },
    { destroyed: false, writable: true, write: (c) => writes.push(c), end: () => {} },
  ]);
  const sink = createHTTPFanout(clients);
  sink.write(Buffer.from("x"));
  assert.equal(writes.length, 1);
});

test("createHTTPFanout close() ends every client and empties the set", () => {
  let ended = 0;
  const clients = new Set([
    { destroyed: false, writable: true, write: () => {}, end: () => { ended++; } },
    { destroyed: false, writable: true, write: () => {}, end: () => { ended++; } },
  ]);
  const sink = createHTTPFanout(clients);
  sink.close();
  assert.equal(ended, 2);
  assert.equal(clients.size, 0);
});

test("createUDPSink actually delivers packets to the target host:port", async () => {
  const { createUDPSink } = require("../outputs.js");
  const receiver = dgram.createSocket("udp4");
  await new Promise((resolve) => receiver.bind(0, "127.0.0.1", resolve));
  const port = receiver.address().port;

  const received = new Promise((resolve) => {
    receiver.once("message", (msg) => resolve(msg));
  });

  const sink = createUDPSink("127.0.0.1", port);
  sink.write(Buffer.from("ping"));

  const msg = await received;
  assert.equal(msg.toString(), "ping");

  sink.close();
  receiver.close();
});
