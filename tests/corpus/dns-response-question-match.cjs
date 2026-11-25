// A UDP responder that answers the first query under its transaction id but
// with another host's question: the resolver ignores it and retransmits,
// taking the answer that matches. The ids of the outstanding queries are
// random rather than a counter, so successive lookups do not differ by one.
const dns = require("node:dns");
const { createSocket } = require("node:dgram");

function u16(n) {
  const value = Buffer.alloc(2);
  value.writeUInt16BE(n, 0);
  return value;
}

function u32(n) {
  const value = Buffer.alloc(4);
  value.writeUInt32BE(n, 0);
  return value;
}

function questionEnd(message) {
  let at = 12;
  while (at < message.length && message[at] !== 0) at += message[at] + 1;
  return at + 5;
}

function encodedName(name) {
  const parts = name.split(".");
  const out = [];
  for (const part of parts) {
    out.push(Buffer.alloc(1, part.length));
    out.push(Buffer.from(part));
  }
  out.push(Buffer.alloc(1, 0));
  return Buffer.concat(out);
}

function header(id, answers) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(0x8180, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(answers, 6);
  return head;
}

function aRecord(address) {
  const bytes = Buffer.alloc(4, 0);
  const parts = address.split(".");
  for (let i = 0; i < 4; i++) bytes.writeUInt8(Number(parts[i]), i);
  return Buffer.concat([u16(0xc00c), u16(1), u16(1), u32(60), u16(4), bytes]);
}

const ids = [];
let forged = false;
const udp = createSocket("udp4");
udp.on("message", (message, rinfo) => {
  const id = message.readUInt16BE(0);
  const question = message.subarray(12, questionEnd(message));
  ids.push(id);
  if (!forged) {
    forged = true;
    const response = Buffer.concat([
      header(id, 1),
      encodedName("forged.example"),
      u16(1),
      u16(1),
      aRecord("203.0.113.9"),
    ]);
    udp.send(response, rinfo.port, rinfo.address);
    return;
  }
  udp.send(Buffer.concat([header(id, 1), question, aRecord("127.0.0.1")]), rinfo.port, rinfo.address);
});

udp.bind(0, "127.0.0.1", () => {
  const server = "127.0.0.1:" + udp.address().port;
  const resolver = new dns.Resolver({ timeout: 100, tries: 2 });
  resolver.setServers([server]);
  resolver.resolve4("real.example", (err, addresses) => {
    console.log("forged question", err ? err.code : JSON.stringify(addresses));
    const sweep = new dns.Resolver({ timeout: 500, tries: 1 });
    sweep.setServers([server]);
    let left = 20;
    for (let i = 0; i < 20; i++) {
      sweep.resolve4("n" + i + ".example", (error) => {
        if (error) console.log("query error", i, error.code);
        left--;
        if (left === 0) {
          const tail = ids.slice(ids.length - 20);
          let counter = true;
          for (let k = 1; k < tail.length; k++) {
            if (tail[k] !== ((tail[k - 1] + 1) & 0xffff)) counter = false;
          }
          console.log("sequential ids", counter, "distinct", new Set(tail).size === tail.length);
          udp.close();
        }
      });
    }
  });
});
