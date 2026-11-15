// A nameserver whose UDP port answers ICMP port-unreachable is one failed
// attempt: c-ares requeues the query for the next configured server, so a
// resolver with a dead server first still answers. Only a query whose
// attempts all end that way reports ECONNREFUSED, and it does not become an
// ETIMEOUT. The dead server is a loopback UDP port bound and closed here.
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
udp.on("message", (msg, rinfo) => udp.send(reply(msg), rinfo.port, rinfo.address));

let live = "";
let dead = "";

const cases = [
  ["fallback", () => [dead, live], "fallback.test"],
  ["fallback three", () => [dead, dead, live], "fallback-three.test"],
  ["refused", () => [dead], "refused.test"],
  ["live", () => [live], "live.test"],
];

function step(index) {
  if (index === cases.length) {
    udp.close();
    return;
  }
  const [label, servers, name] = cases[index];
  const resolver = new dns.Resolver();
  resolver.setServers(servers());
  resolver.resolve4(name, (err, addrs) => {
    console.log(label, err ? err.code : "ok", err ? err.syscall : "", JSON.stringify(addrs));
    step(index + 1);
  });
}

udp.bind(0, "127.0.0.1", () => {
  live = "127.0.0.1:" + udp.address().port;
  const deadSocket = createSocket("udp4");
  deadSocket.bind(0, "127.0.0.1", () => {
    dead = "127.0.0.1:" + deadSocket.address().port;
    deadSocket.close();
    step(0);
  });
});
