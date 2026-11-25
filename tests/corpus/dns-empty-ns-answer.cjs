// An answer with no record of the queried type: an NS or PTR query whose
// response carries only an A record is ENODATA, and nothing from the response
// stays live.
const dns = require("node:dns");
const { createSocket } = require("node:dgram");

function questionEnd(query) {
  let i = 12;
  while (i < query.length && query[i] !== 0) i += query[i] + 1;
  return i + 5;
}

const udp = createSocket("udp4");
udp.on("message", (msg, rinfo) => {
  const end = questionEnd(msg);
  const head = Buffer.alloc(12);
  msg.copy(head, 0, 0, 2);
  head.writeUInt16BE(0x8400, 2); // QR | RD, rcode 0
  head.writeUInt16BE(1, 4); // one question
  head.writeUInt16BE(1, 6); // one answer
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // the question's name
  answer.writeUInt16BE(1, 2); // A
  answer.writeUInt16BE(1, 4); // IN
  answer.writeUInt32BE(60, 6);
  answer.writeUInt16BE(4, 10);
  answer[12] = 192;
  answer[13] = 0;
  answer[14] = 2;
  answer[15] = 1;
  udp.send(Buffer.concat([head, msg.slice(12, end), answer]), rinfo.port, rinfo.address);
});

function query(label, fn) {
  return new Promise((resolve) => {
    fn((err, records) => {
      console.log(label, err === null ? records : err.code);
      resolve(undefined);
    });
  });
}

udp.bind(0, "127.0.0.1", () => {
  run(udp.address().port);
});

async function run(port) {
  dns.setServers(["127.0.0.1:" + port]);
  await query("ns", (cb) => dns.resolveNs("a.test", cb));
  await query("ns again", (cb) => dns.resolveNs("b.test", cb));
  await query("ptr", (cb) => dns.resolvePtr("4.3.2.1.in-addr.arpa", cb));
  udp.close();
  console.log("done");
}
