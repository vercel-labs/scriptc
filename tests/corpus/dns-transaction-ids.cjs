// A batch of concurrent lookups against one responder. Each query owns its
// socket, so the transaction ids only need to be unpredictable, not distinct
// from other queries' ids; the responder records them, and the program prints
// whether they look like a counter (a sequenced id is predictable).
const dns = require("node:dns");
const { createSocket } = require("node:dgram");

const queries = 200;
const seen = [];
let settled = 0;

function questionEnd(query) {
  let i = 12;
  while (i < query.length && query[i] !== 0) i += query[i] + 1;
  return i + 5;
}

const udp = createSocket("udp4");
udp.on("message", (msg, rinfo) => {
  seen.push((msg[0] << 8) | msg[1]);
  const end = questionEnd(msg);
  const head = Buffer.alloc(12);
  msg.copy(head, 0, 0, 2);
  head.writeUInt16BE(0x8400, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(1, 6);
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(60, 6);
  answer.writeUInt16BE(4, 10);
  answer[12] = 192;
  answer[13] = 0;
  answer[14] = 2;
  answer[15] = 1;
  udp.send(Buffer.concat([head, msg.slice(12, end), answer]), rinfo.port, rinfo.address);
});

function finish() {
  let sequential = 0;
  for (let i = 1; i < seen.length; i++) {
    if (((seen[i - 1] + 1) & 0xffff) === seen[i]) sequential += 1;
  }
  console.log("settled", settled, "ids", seen.length, "counter", sequential > seen.length / 2);
  udp.close();
}

udp.bind(0, "127.0.0.1", () => {
  const port = udp.address().port;
  dns.setServers(["127.0.0.1:" + port]);
  for (let i = 0; i < queries; i++) {
    dns.resolve4("h" + i + ".test", (error, records) => {
      if (error) console.log("error", error.code);
      settled += 1;
      if (settled === queries) finish();
    });
  }
});
