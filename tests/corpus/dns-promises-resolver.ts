// node:dns/promises' Resolver: every promise query form against a local
// authoritative responder, the ttl option, setLocalAddress, cancel(), the
// constructor's options checks, and the argument errors (which throw
// synchronously, before a promise exists) and rejected queries.
import { Resolver } from "node:dns/promises";
import * as dnsPromises from "node:dns/promises";
import { createSocket } from "node:dgram";

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

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function str(s: string): Buffer {
  const b = Buffer.alloc(s.length + 1);
  b.writeUInt8(s.length, 0);
  for (let i = 0; i < s.length; i++) b.writeUInt8(s.charCodeAt(i), i + 1);
  return b;
}

function nameWire(name: string): Buffer {
  const chunks = name.split(".").map((part) => str(part));
  chunks.push(Buffer.alloc(1));
  return Buffer.concat(chunks);
}

function rr(type: number, ttl: number, rdata: Buffer): Buffer {
  const owner = Buffer.alloc(2);
  owner.writeUInt8(0xc0, 0);
  owner.writeUInt8(0x0c, 1);
  return Buffer.concat([owner, u16(type), u16(1), u32(ttl), u16(rdata.length), rdata]);
}

function aData(ip: string): Buffer {
  const b = Buffer.alloc(4);
  ip.split(".").forEach((part, i) => b.writeUInt8(Number(part), i));
  return b;
}

function aaaaData(ip: string): Buffer {
  const halves = ip.split("::");
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length > 1 && halves[1] !== "" ? halves[1].split(":") : [];
  const groups: string[] = [];
  for (const g of head) groups.push(g);
  for (let i = groups.length + tail.length; i < 8; i++) groups.push("0");
  for (const g of tail) groups.push(g);
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

function answer(name: string, qtype: number, out: Buffer[]): number {
  const want = (t: number) => qtype === t || qtype === T_ANY;
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
      out.push(rr(T_MX, 300, Buffer.concat([u16(30), nameWire("mail2.test")])));
      out.push(rr(T_MX, 300, Buffer.concat([u16(10), nameWire("mail.test")])));
    }
    return 0;
  }
  if (name === "ns.test") {
    if (want(T_NS)) out.push(rr(T_NS, 300, nameWire("ns1.test")));
    return 0;
  }
  if (name === "txt.test") {
    if (want(T_TXT)) out.push(rr(T_TXT, 90, Buffer.concat([str("first"), str("second")])));
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
    if (want(T_MX)) out.push(rr(T_MX, 200, Buffer.concat([u16(5), nameWire("mail.test")])));
    return 0;
  }
  if (name === "1.2.0.192.in-addr.arpa") {
    if (want(T_PTR)) out.push(rr(T_PTR, 45, nameWire("one.test")));
    return 0;
  }
  return 3;
}

function questionEnd(query: Buffer): number {
  let i = 12;
  while (i < query.length && query[i] !== 0) i += query[i] + 1;
  return i + 5;
}

function questionName(query: Buffer): string {
  const labels: string[] = [];
  let i = 12;
  while (i < query.length && query[i] !== 0) {
    const len = query[i];
    labels.push(query.slice(i + 1, i + 1 + len).toString("latin1"));
    i += len + 1;
  }
  return labels.join(".");
}

function reply(query: Buffer): Buffer {
  const name = questionName(query);
  const qtype = query.readUInt16BE(questionEnd(query) - 4);
  const records: Buffer[] = [];
  const rcode = answer(name, qtype, records);
  const head = Buffer.alloc(12);
  query.copy(head, 0, 0, 2);
  head.writeUInt16BE(0x8400 | rcode, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(records.length, 6);
  return Buffer.concat([head, query.slice(12, questionEnd(query))].concat(records));
}

function attempt(label: string, f: () => unknown): void {
  try {
    f();
    console.log(label, "ok");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, "throws", e.name, e.code, e.message);
  }
}

function report(label: string, value: unknown): void {
  console.log(label, JSON.stringify(value));
}

function failure(label: string) {
  return (error: NodeJS.ErrnoException) => console.log(label, "rejected", error.code, error.syscall);
}

const udp = createSocket("udp4");
udp.on("message", (msg: Buffer, rinfo) => {
  udp.send(reply(msg), rinfo.port, rinfo.address);
});

async function queries(port: number): Promise<void> {
  console.log("order", dnsPromises.getDefaultResultOrder());
  dnsPromises.setDefaultResultOrder("ipv4first");
  console.log("order", dnsPromises.getDefaultResultOrder());
  attempt("bad order", () => dnsPromises.setDefaultResultOrder("first" as "verbatim"));
  dnsPromises.setDefaultResultOrder("verbatim");

  const resolver = new Resolver();
  resolver.setServers(["127.0.0.1:" + port]);
  report("resolve4", await resolver.resolve4("a.test"));
  report("resolve4 ttl", await resolver.resolve4("a.test", { ttl: true }));
  report("resolve6", await resolver.resolve6("aaaa.test"));
  report("resolve default", await resolver.resolve("a.test"));
  report("resolve A", await resolver.resolve("a.test", "A"));
  report("resolve AAAA", await resolver.resolve("aaaa.test", "AAAA"));
  report("resolve CNAME", await resolver.resolve("cname.test", "CNAME"));
  report("resolve NS", await resolver.resolve("ns.test", "NS"));
  report("resolve PTR", await resolver.resolve("ptr.test", "PTR"));
  report("resolve MX", await resolver.resolve("mx.test", "MX"));
  report("resolve TXT", await resolver.resolve("txt.test", "TXT"));
  report("resolve SRV", await resolver.resolve("srv.test", "SRV"));
  report("resolve NAPTR", await resolver.resolve("naptr.test", "NAPTR"));
  report("resolve SOA", await resolver.resolve("soa.test", "SOA"));
  report("resolve TLSA", await resolver.resolve("tlsa.test", "TLSA"));
  report("resolve CAA", await resolver.resolve("caa.test", "CAA"));
  report("resolve ANY", await resolver.resolve("mixed.test", "ANY"));
  report("resolveAny", await resolver.resolveAny("a.test"));
  report("reverse", await resolver.reverse("192.0.2.1"));
  report("resolveCname", await resolver.resolveCname("cname.test"));
  report("resolveNs", await resolver.resolveNs("ns.test"));
  report("resolvePtr", await resolver.resolvePtr("ptr.test"));
  report("resolveMx", await resolver.resolveMx("mx.test"));
  report("resolveTxt", await resolver.resolveTxt("txt.test"));
  report("resolveSrv", await resolver.resolveSrv("srv.test"));
  report("resolveNaptr", await resolver.resolveNaptr("naptr.test"));
  report("resolveSoa", await resolver.resolveSoa("soa.test"));
  report("resolveTlsa", await resolver.resolveTlsa("tlsa.test"));
  report("resolveCaa", await resolver.resolveCaa("caa.test"));
  report("resolveAny mixed", await resolver.resolveAny("mixed.test"));

  attempt("resolve numeric name", () => resolver.resolve4(42 as unknown as string));
  attempt("resolve bad rrtype", () => resolver.resolve("a.test", "BOGUS"));
  await resolver
    .resolve4("nxdomain.test")
    .then(report.bind(null, "resolve4 nxdomain"), failure("resolve4 nxdomain"));
  await resolver
    .resolveTxt("nxdomain.test")
    .then(report.bind(null, "resolveTxt nxdomain"), failure("resolveTxt nxdomain"));
  await resolver
    .reverse("not-an-ip")
    .then(report.bind(null, "reverse bad"), failure("reverse bad"));

  const local = new Resolver();
  local.setServers(["127.0.0.1:" + port]);
  local.setLocalAddress("127.0.0.1");
  report("local address", await local.resolve4("a.test"));

  const cancellable = new Resolver({ timeout: 50, tries: 1 });
  cancellable.setServers(["127.0.0.1:" + port]);
  const cancelled = cancellable.resolve4("blackhole.test");
  cancellable.cancel();
  cancellable.cancel();
  await cancelled.then(report.bind(null, "cancel"), failure("cancel"));

  const badTimeout: any = "x";
  attempt("bad timeout", () => new Resolver({ timeout: badTimeout }));
  attempt("bad tries", () => new Resolver({ tries: 1.5 }));
  attempt("bad options", () => new Resolver(5 as unknown as object));
}

udp.bind(0, "127.0.0.1", () => {
  const port = udp.address().port;
  void queries(port).then(() => {
    udp.close();
    console.log("done");
  });
});
