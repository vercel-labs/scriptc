// node:dns/promises' module-level functions through the CommonJS module:
// setServers replaces the promise module's default resolver (node:dns keeps
// its own), every resolve* promise form and reverse() answer from the local
// responder, and failures reject while argument errors throw synchronously.
// The module object is read live, so the rebound functions see the servers
// the set installed.
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");
const { createSocket } = require("node:dgram");

const T_A = 1;
const T_AAAA = 28;
const T_CNAME = 5;
const T_MX = 15;
const T_TXT = 16;
const T_SRV = 33;
const T_PTR = 12;

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

function str(s) {
  const b = Buffer.alloc(s.length + 1);
  b.writeUInt8(s.length, 0);
  for (let i = 0; i < s.length; i++) b.writeUInt8(s.charCodeAt(i), i + 1);
  return b;
}

function nameWire(name) {
  return Buffer.concat([...name.split(".").map(str), Buffer.alloc(1)]);
}

function rr(type, ttl, rdata) {
  const owner = Buffer.alloc(2);
  owner.writeUInt8(0xc0, 0);
  owner.writeUInt8(0x0c, 1);
  return Buffer.concat([owner, u16(type), u16(1), u32(ttl), u16(rdata.length), rdata]);
}

function aData(ip) {
  const b = Buffer.alloc(4);
  ip.split(".").forEach((part, i) => b.writeUInt8(Number(part), i));
  return b;
}

function aaaaData(ip) {
  const halves = ip.split("::");
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length > 1 && halves[1] !== "" ? halves[1].split(":") : [];
  const groups = [...head];
  while (groups.length + tail.length < 8) groups.push("0");
  groups.push(...tail);
  const b = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) b.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  return b;
}

function answer(name, qtype, out) {
  const want = (t) => qtype === t || qtype === 255;
  if (name === "a.test") {
    if (want(T_A)) out.push(rr(T_A, 120, aData("192.0.2.1")));
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
    if (want(T_MX)) out.push(rr(T_MX, 300, Buffer.concat([u16(10), nameWire("mail.test")])));
    return 0;
  }
  if (name === "txt.test") {
    if (want(T_TXT)) out.push(rr(T_TXT, 90, str("hello")));
    return 0;
  }
  if (name === "srv.test") {
    if (want(T_SRV)) out.push(rr(T_SRV, 45, Buffer.concat([u16(1), u16(2), u16(443), nameWire("host.test")])));
    return 0;
  }
  if (name === "1.2.0.192.in-addr.arpa") {
    if (want(T_PTR)) out.push(rr(T_PTR, 45, nameWire("one.test")));
    return 0;
  }
  return 3;
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
    labels.push(query.slice(i + 1, i + 1 + len).toString("latin1"));
    i += len + 1;
  }
  return labels.join(".");
}

function reply(query) {
  const name = questionName(query);
  const qtype = query.readUInt16BE(questionEnd(query) - 4);
  const records = [];
  const rcode = answer(name, qtype, records);
  const head = Buffer.alloc(12);
  query.copy(head, 0, 0, 2);
  head.writeUInt16BE(0x8400 | rcode, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(records.length, 6);
  return Buffer.concat([head, query.slice(12, questionEnd(query))].concat(records));
}

function attempt(label, f) {
  try {
    f();
    console.log(label, "ok");
  } catch (error) {
    console.log(label, "throws", error.name, error.code, error.message);
  }
}

const udp = createSocket("udp4");
udp.on("message", (msg, rinfo) => {
  udp.send(reply(msg), rinfo.port, rinfo.address);
});

let port = 0;
function mask(text) {
  return port === 0 ? text : text.split(":" + port).join(":port");
}

async function run() {
  dnsPromises.setServers(["127.0.0.1:" + port]);
  console.log("set", mask(JSON.stringify(dnsPromises.getServers())));
  console.log("dns module servers", JSON.stringify(dns.getServers()) !== JSON.stringify(dnsPromises.getServers()));
  attempt("setServers not an array", () => dnsPromises.setServers("127.0.0.1"));
  attempt("setServers bad entry", () => dnsPromises.setServers(["not-an-ip"]));
  console.log("kept", mask(JSON.stringify(dnsPromises.getServers())));

  console.log("order", dnsPromises.getDefaultResultOrder());
  dnsPromises.setDefaultResultOrder("ipv4first");
  console.log("order", dnsPromises.getDefaultResultOrder());
  attempt("bad order", () => dnsPromises.setDefaultResultOrder("first"));
  dnsPromises.setDefaultResultOrder("verbatim");

  console.log("resolve4", JSON.stringify(await dnsPromises.resolve4("a.test")));
  console.log("resolve4 ttl", JSON.stringify(await dnsPromises.resolve4("a.test", { ttl: true })));
  console.log("resolve6", JSON.stringify(await dnsPromises.resolve6("aaaa.test")));
  console.log("resolve default", JSON.stringify(await dnsPromises.resolve("a.test")));
  console.log("resolve MX", JSON.stringify(await dnsPromises.resolve("mx.test", "MX")));
  console.log("resolveAny", JSON.stringify(await dnsPromises.resolveAny("a.test")));
  console.log("resolveCname", JSON.stringify(await dnsPromises.resolveCname("cname.test")));
  console.log("resolveMx", JSON.stringify(await dnsPromises.resolveMx("mx.test")));
  console.log("resolveTxt", JSON.stringify(await dnsPromises.resolveTxt("txt.test")));
  console.log("resolveSrv", JSON.stringify(await dnsPromises.resolveSrv("srv.test")));
  console.log("reverse", JSON.stringify(await dnsPromises.reverse("192.0.2.1")));

  attempt("numeric name", () => dnsPromises.resolve4(42));
  attempt("bad rrtype", () => dnsPromises.resolve("a.test", "BOGUS"));
  await dnsPromises.resolve4("nxdomain.test").then(
    (v) => console.log("nxdomain", "resolved", JSON.stringify(v)),
    (e) => console.log("nxdomain", "rejected", e.code, e.syscall),
  );
  await dnsPromises.reverse("not-an-ip").then(
    (v) => console.log("reverse bad", "resolved", JSON.stringify(v)),
    (e) => console.log("reverse bad", "rejected", e.code, e.syscall),
  );
  console.log("done");
}

udp.bind(0, "127.0.0.1", () => {
  port = udp.address().port;
  void run().then(() => udp.close());
});
