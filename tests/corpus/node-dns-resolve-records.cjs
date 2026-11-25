// dns's stub resolver (the CommonJS module, whose calls see setServers) against a local authoritative responder: every
// record type the query functions shape, resolve4/resolve6's ttl option,
// resolve()'s rrtype forms, ANY's ordering, reverse(), and a response too
// large for UDP (the TCP retry). The servers are set to the local port,
// so the answers are the responder's, not the environment's.
const dns = require("node:dns");
const { createSocket } = require("node:dgram");
const { createServer } = require("node:net");

const T_A = 1;
const T_NS = 2;
const T_CNAME = 5;
const T_SOA = 6;
const T_PTR = 12;
const T_MX = 15;
const T_TXT = 16;
const T_AAAA = 28;
const T_SRV = 33;
const T_NAPTR = 35;
const T_TLSA = 52;
const T_CAA = 257;
const T_ANY = 255;

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

/* A DNS character-string: one length byte and the bytes. */
function str(s) {
  const b = Buffer.alloc(s.length + 1);
  b.writeUInt8(s.length, 0);
  for (let i = 0; i < s.length; i++) b.writeUInt8(s.charCodeAt(i), i + 1);
  return b;
}

function nameWire(name) {
  const chunks = [];
  const parts = name.split(".");
  for (let i = 0; i < parts.length; i++) {
    chunks.push(str(parts[i]));
  }
  chunks.push(Buffer.alloc(1));
  return Buffer.concat(chunks);
}

/* An answer record whose owner is a compression pointer to the question
 * name at offset 12. */
function rr(type, ttl, rdata) {
  const owner = Buffer.alloc(2);
  owner.writeUInt8(0xc0, 0);
  owner.writeUInt8(0x0c, 1);
  return Buffer.concat([owner, u16(type), u16(1), u32(ttl), u16(rdata.length), rdata]);
}

function aData(ip) {
  const parts = ip.split(".");
  const b = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) b.writeUInt8(Number(parts[i]), i);
  return b;
}

function aaaaData(ip) {
  const halves = ip.split("::");
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length > 1 && halves[1] !== "" ? halves[1].split(":") : [];
  const groups = [];
  for (let i = 0; i < head.length; i++) groups.push(head[i]);
  for (let i = groups.length + tail.length; i < 8; i++) groups.push("0");
  for (let i = 0; i < tail.length; i++) groups.push(tail[i]);
  const b = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) b.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  return b;
}

const tlsaData = Buffer.alloc(35);
tlsaData.writeUInt8(3, 0);
tlsaData.writeUInt8(1, 1);
tlsaData.writeUInt8(1, 2);
for (let i = 0; i < 32; i++) tlsaData.writeUInt8(i, i + 3);

const soaData = Buffer.concat([
  nameWire("ns.test"),
  nameWire("hostmaster.test"),
  u32(2024050607),
  u32(7200),
  u32(3600),
  u32(1209600),
  u32(300),
]);

const bigEntries = [];
for (let i = 0; i < 30; i++) {
  let s = "entry" + i + "-";
  while (s.length < 60) s += "x";
  bigEntries.push(s);
}
const bigTxt = Buffer.concat(bigEntries.map((e) => str(e)));
const bigAnswer = rr(T_TXT, 60, bigTxt);

/* The responder's records per name and qtype: `answer` pushes them and
 * answers the rcode. */
function answer(name, qtype, out) {
  const want = (t) => qtype === t || qtype === T_ANY;
  if (name === "a.test") {
    if (want(T_A)) {
      out.push(rr(T_A, 120, aData("192.0.2.1")));
      out.push(rr(T_A, 121, aData("192.0.2.2")));
    }
    return 0;
  }
  if (name === "aaaa.test") {
    if (want(T_AAAA)) out.push(rr(T_AAAA, 60, aaaaData("2001:db8::1")));
    return 0;
  }
  if (name === "cname.test") {
    if (want(T_CNAME)) out.push(rr(T_CNAME, 30, nameWire("a.test")));
    return 0;
  }
  if (name === "mx.test") {
    if (want(T_MX)) {
      out.push(rr(T_MX, 300, Buffer.concat([u16(20), nameWire("mail2.test")])));
      out.push(rr(T_MX, 300, Buffer.concat([u16(10), nameWire("mail.test")])));
    }
    return 0;
  }
  if (name === "ns.test") {
    if (want(T_NS)) {
      out.push(rr(T_NS, 300, nameWire("ns1.test")));
      out.push(rr(T_NS, 300, nameWire("ns2.test")));
    }
    return 0;
  }
  if (name === "txt.test") {
    if (want(T_TXT)) {
      out.push(rr(T_TXT, 90, Buffer.concat([str("v=spf1 -all")])));
      out.push(rr(T_TXT, 90, Buffer.concat([str("first"), str("second")])));
    }
    return 0;
  }
  if (name === "srv.test") {
    if (want(T_SRV))
      out.push(rr(T_SRV, 45, Buffer.concat([u16(10), u16(60), u16(443), nameWire("host.test")])));
    return 0;
  }
  if (name === "ptr.test") {
    if (want(T_PTR)) out.push(rr(T_PTR, 45, nameWire("host.test")));
    return 0;
  }
  if (name === "naptr.test") {
    if (want(T_NAPTR))
      out.push(
        rr(
          T_NAPTR,
          45,
          Buffer.concat([
            u16(100),
            u16(10),
            str("S"),
            str("SIP+D2U"),
            str(""),
            nameWire("_sip._udp.test"),
          ]),
        ),
      );
    return 0;
  }
  if (name === "soa.test") {
    if (want(T_SOA)) out.push(rr(T_SOA, 45, soaData));
    return 0;
  }
  if (name === "tlsa.test") {
    if (want(T_TLSA)) out.push(rr(T_TLSA, 45, tlsaData));
    return 0;
  }
  if (name === "caa.test") {
    if (want(T_CAA))
      out.push(rr(T_CAA, 45, Buffer.concat([Buffer.alloc(1), str("issue"), Buffer.from("ca.test")])));
    return 0;
  }
  if (name === "mixed.test") {
    out.push(rr(T_A, 100, aData("192.0.2.9")));
    out.push(rr(T_MX, 200, Buffer.concat([u16(5), nameWire("mail.test")])));
    return 0;
  }
  if (name === "big.test") {
    if (want(T_TXT)) out.push(bigAnswer);
    return 0;
  }
  if (name === "1.2.0.192.in-addr.arpa") {
    if (want(T_PTR)) out.push(rr(T_PTR, 45, nameWire("one.test")));
    return 0;
  }
  return 3; /* NXDOMAIN */
}

function questionEnd(query) {
  let i = 12;
  while (i < query.length && query[i] !== 0) i += query[i] + 1;
  return i + 5;
}

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

/* The reply: the query's id and question, the responder's records, and the
 * truncated bit when `tcp` is false and the reply would not fit. */
function reply(query, tcp) {
  const name = questionName(query);
  const qtype = query.readUInt16BE(questionEnd(query) - 4);
  const records = [];
  const rcode = answer(name, qtype, records);
  let body = records;
  let truncated = false;
  if (!tcp) {
    let size = questionEnd(query);
    for (let i = 0; i < body.length; i++) size += body[i].length;
    if (size > 512) {
      body = [];
      truncated = true;
    }
  }
  const head = Buffer.alloc(12);
  query.copy(head, 0, 0, 2);
  let flags = 0x8400; /* QR | AA */
  if ((query.readUInt16BE(2) & 0x0100) !== 0) flags |= 0x0100; /* RD */
  flags |= rcode;
  if (truncated) flags |= 0x0200;
  head.writeUInt16BE(flags, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(body.length, 6);
  return Buffer.concat([head, query.slice(12, questionEnd(query))].concat(body));
}

const udp = createSocket("udp4");
udp.on("message", (msg, rinfo) => {
  udp.send(reply(msg, false), rinfo.port, rinfo.address);
});

let port = 0;
/* The responder's port is ephemeral, so it never reaches the compared
 * output: the servers a set makes read back as ":port". */
function mask(text) {
  return port === 0 ? text : text.split(":" + port).join(":port");
}
function dump(label, value) {
  console.log(label, mask(JSON.stringify(value)));
}

const tcp = createServer((conn) => {
  let buffered = Buffer.alloc(0);
  conn.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length < 2) return;
    const len = buffered.readUInt16BE(0);
    if (buffered.length < 2 + len) return;
    const msg = buffered.slice(2, 2 + len);
    const body = reply(msg, true);
    conn.write(Buffer.concat([u16(body.length), body]));
  });
});

udp.bind(0, "127.0.0.1", () => {
  port = udp.address().port;
  tcp.listen(port, "127.0.0.1", () => {
    dns.setServers(["127.0.0.1:" + port]);
    dump("servers", dns.getServers());
    void run();
  });
});

async function run() {
  await new Promise((resolve) => {
    dns.resolve4("a.test", { ttl: true }, (err, addrs) => {
      dump("resolve4 ttl", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolve4("a.test", (err, addrs) => {
      dump("resolve4", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolve6("aaaa.test", { ttl: true }, (err, addrs) => {
      dump("resolve6 ttl", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolve6("aaaa.test", (err, addrs) => {
      dump("resolve6", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolveAny("mixed.test", (err, addrs) => {
      dump("resolveAny", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolveCaa("caa.test", (err, addrs) => {
      dump("resolveCaa", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolveCname("cname.test", (err, addrs) => {
      dump("resolveCname", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolveMx("mx.test", (err, addrs) => {
      dump("resolveMx", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolveNaptr("naptr.test", (err, addrs) => {
      dump("resolveNaptr", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolveNs("ns.test", (err, addrs) => {
      dump("resolveNs", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolvePtr("ptr.test", (err, addrs) => {
      dump("resolvePtr", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolveSoa("soa.test", (err, addrs) => {
      dump("resolveSoa", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolveSrv("srv.test", (err, addrs) => {
      dump("resolveSrv", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolveTlsa("tlsa.test", (err, addrs) => {
      dump("resolveTlsa", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolveTxt("txt.test", (err, addrs) => {
      dump("resolveTxt", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolve("mx.test", "MX", (err, addrs) => {
      dump("resolve MX", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolve("a.test", (err, addrs) => {
      dump("resolve A", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.reverse("192.0.2.1", (err, addrs) => {
      dump("reverse", err === null ? addrs : err.code);
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    dns.resolveTxt("big.test", (err, addrs) => {
      const entries = err === null ? addrs.map((e) => e.length + "/" + e[0].length) : err.code;
      dump("resolveTxt tcp", entries);
      resolve(undefined);
    });
  });
  udp.close();
  console.log("done");
  tcp.close();
}
