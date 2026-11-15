// A query name is encoded in ada's ToASCII form before it goes on the wire:
// "ü.test" is six bytes of UTF-8 and its ASCII form "xn--tda.test" is
// twelve, so a packet sized from the caller's string is too small for a
// valid encoded name. A local responder answers every query and echoes the
// question it received, so the corpus compares the wire name too.
const dns = require("node:dns");
const { createSocket } = require("node:dgram");

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function questionName(query) {
  const labels = [];
  let i = 12;
  while (i < query.length && query[i] !== 0) {
    const len = query[i];
    labels.push(query.slice(i + 1, i + 1 + len).toString("latin1"));
    i += len + 1;
  }
  return labels.join(".");
}

function questionEnd(query) {
  let i = 12;
  while (i < query.length && query[i] !== 0) i += query[i] + 1;
  return i + 5;
}

function reply(query) {
  const a = Buffer.from([192, 0, 2, 9]);
  const rr = Buffer.concat([
    Buffer.from([0xc0, 0x0c]),
    u16(1), // A
    u16(1), // IN
    u32(60),
    u16(a.length),
    a,
  ]);
  const head = Buffer.alloc(12);
  query.copy(head, 0, 0, 2);
  head.writeUInt16BE(0x8400, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(1, 6);
  return Buffer.concat([head, query.slice(12, questionEnd(query)), rr]);
}

const udp = createSocket("udp4");
const asked = [];
udp.on("message", (msg, rinfo) => {
  asked.push(questionName(msg));
  udp.send(reply(msg), rinfo.port, rinfo.address);
});

const cases = [
  ["plain.test", "plain"],
  ["ü.test", "idna"],
  ["münchen.test", "idna long"],
  ["BÜCHER.test", "idna upper"],
];

function step(resolver, index) {
  if (index === cases.length) {
    udp.close();
    return;
  }
  const [name, label] = cases[index];
  resolver.resolve4(name, (err, addrs) => {
    console.log(label, err ? err.code : "ok", JSON.stringify(addrs), JSON.stringify(asked));
    step(resolver, index + 1);
  });
}

udp.bind(0, "127.0.0.1", () => {
  const resolver = new dns.Resolver();
  resolver.setServers(["127.0.0.1:" + udp.address().port]);
  step(resolver, 0);
});
