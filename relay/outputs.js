// Output sinks: UDP multicast and HTTP progressive.
// The UDP sink is the only one with non-trivial logic — TS-aligned packet
// sizing and optional multicast TTL.

const dgram = require("node:dgram");

const TS_PACKET = 188;
const UDP_PAYLOAD = TS_PACKET * 7; // 1316 bytes fits under a 1500-byte MTU

function parseUDPOutput(outputStr) {
  const parsed = new URL(outputStr);
  const host = parsed.hostname;
  const port = parseInt(parsed.port, 10);
  const firstOctet = parseInt(host.split(".")[0], 10);
  const isMulticast = firstOctet >= 224 && firstOctet <= 239;
  return { host, port, isMulticast };
}

function* chunkForUDP(buffer) {
  for (let i = 0; i < buffer.length; i += UDP_PAYLOAD) {
    yield buffer.slice(i, Math.min(i + UDP_PAYLOAD, buffer.length));
  }
}

function createUDPSink(host, port) {
  const socket = dgram.createSocket("udp4");
  const firstOctet = parseInt(host.split(".")[0], 10);
  const isMulticast = firstOctet >= 224 && firstOctet <= 239;
  if (isMulticast) {
    socket.bind(0, () => socket.setMulticastTTL(4));
  }
  return {
    write(chunk) {
      for (const pkt of chunkForUDP(chunk)) {
        socket.send(pkt, port, host);
      }
    },
    close() {
      socket.close();
    },
  };
}

function createHTTPFanout(clients) {
  return {
    write(chunk) {
      for (const res of clients) {
        if (!res.destroyed && res.writable) {
          res.write(chunk);
        }
      }
    },
    close() {
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

module.exports = {
  parseUDPOutput,
  chunkForUDP,
  createUDPSink,
  createHTTPFanout,
  UDP_PAYLOAD,
};
