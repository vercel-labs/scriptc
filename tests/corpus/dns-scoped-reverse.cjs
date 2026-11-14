// reverse() with a scoped IPv6 address: the zone is not part of the address
// and the question the responder sees is the address's nibble name, as for the
// unscoped spelling. The responder reports each question it receives and
// answers NXDOMAIN.
const dns = require("node:dns");
const { createSocket } = require("node:dgram");

function questionName(query) {
  const labels = [];
  let i = 12;
  while (i < query.length && query[i] !== 0) {
    const len = query[i];
    const parts = [];
    for (let k = 0; k < len; k++) parts.push(String.fromCharCode(query[i + 1 + k]));
    labels.push(parts.join(""));
    i += len + 1;
  }
  return labels.join(".");
}

const udp = createSocket("udp4");
udp.on("message", (msg, rinfo) => {
  console.log("q", questionName(msg));
  if (msg.length < 12) return;
  const end = (() => {
    let i = 12;
    while (i < msg.length && msg[i] !== 0) i += msg[i] + 1;
    return i + 5;
  })();
  const head = Buffer.alloc(12);
  msg.copy(head, 0, 0, 2);
  head.writeUInt16BE(0x8400 | 3, 2);
  head.writeUInt16BE(1, 4);
  udp.send(Buffer.concat([head, msg.slice(12, end)]), rinfo.port, rinfo.address);
});

function reverse(address) {
  return new Promise((resolve) => {
    dns.reverse(address, (err, names) => {
      console.log("reverse", address, err === null ? names : err.code);
      resolve(undefined);
    });
  });
}

udp.bind(0, "127.0.0.1", () => {
  run(udp.address().port);
});

async function run(port) {
  dns.setServers(["127.0.0.1:" + port]);
  await reverse("2001:db8::1");
  await reverse("2001:db8::1%eth0");
  await reverse("fe80::1%");
  try {
    dns.reverse("1.2.3.4%x", () => {});
  } catch (e) {
    console.log("invalid", e.name, e.code, JSON.stringify(e.message));
  }
  udp.close();
  console.log("done");
}
