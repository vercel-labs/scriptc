// dns.Resolver and dns/promises' Resolver as values: instanceof, the
// constructor's options checks, the servers a fresh resolver reports, the
// setServers/setLocalAddress argument checks and normalization, cancel(),
// and the method values' lengths. The queries go to a local responder.
import * as dns from "node:dns";
import { Resolver as PromiseResolver } from "node:dns/promises";
import { createSocket } from "node:dgram";

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function questionEnd(query: Buffer): number {
  let i = 12;
  while (i < query.length && query[i] !== 0) i += query[i] + 1;
  return i + 5;
}

function reply(query: Buffer): Buffer {
  const end = questionEnd(query);
  const head = Buffer.alloc(12);
  query.copy(head, 0, 0, 2);
  head.writeUInt16BE(0x8400, 2);
  head.writeUInt16BE(1, 4);
  const owner = Buffer.alloc(2);
  owner.writeUInt8(0xc0, 0);
  owner.writeUInt8(0x0c, 1);
  const rdata = Buffer.alloc(4);
  rdata.writeUInt8(198, 0);
  rdata.writeUInt8(51, 1);
  rdata.writeUInt8(100, 2);
  rdata.writeUInt8(7, 3);
  head.writeUInt16BE(1, 6);
  const ttl = Buffer.alloc(4);
  const record = Buffer.concat([owner, u16(1), u16(1), ttl, u16(4), rdata]);
  return Buffer.concat([head, query.slice(12, end), record]);
}

function attempt(label: string, f: () => unknown): void {
  try {
    const v = f();
    console.log(label, "ok", JSON.stringify(v));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message);
  }
}

let lastSource = "";
const udp = createSocket("udp4");
udp.on("message", (msg: Buffer, rinfo) => {
  lastSource = rinfo.address;
  udp.send(reply(msg), rinfo.port, rinfo.address);
});

udp.bind(0, "127.0.0.1", () => {
  const port = udp.address().port;
  run("127.0.0.1:" + port, port);
});

/* The responder's port is ephemeral, so it never reaches the compared
 * output: the servers a set makes read back as ":port". */
function masked(value: string[], port: number): string {
  return JSON.stringify(value).split(":" + port).join(":port");
}

async function run(server: string, port: number): Promise<void> {
  const r = new dns.Resolver();
  console.log("instanceof", r instanceof dns.Resolver, r instanceof PromiseResolver);
  console.log("fresh servers", JSON.stringify(r.getServers()));
  console.log("lengths", r.resolve4.length, r.resolve.length, r.getServers.length, r.setServers.length,
    r.cancel.length, r.setLocalAddress.length);
  console.log("typeof", typeof r.resolve4, typeof r.getServers, typeof r.setServers, typeof r.cancel);

  r.setServers([server]);
  console.log("set", masked(r.getServers(), port));
  r.setServers([server, server, "::1", "[::1]:5353", "127.0.0.1", "127.0.0.1:5353"]);
  console.log("normalized", masked(r.getServers(), port));
  r.setServers([]);
  console.log("cleared", JSON.stringify(r.getServers()));
  attempt("setServers string", () => r.setServers("127.0.0.1" as unknown as string[]));
  attempt("setServers bad", () => r.setServers(["nope.test"]));
  attempt("setServers number", () => r.setServers([7] as unknown as string[]));
  attempt("setServers null", () => r.setServers(null as unknown as string[]));

  attempt("setLocalAddress", () => r.setLocalAddress("127.0.0.1"));
  attempt("setLocalAddress v6", () => r.setLocalAddress("127.0.0.1", "::1"));
  attempt("setLocalAddress bad", () => r.setLocalAddress("nonsense"));
  attempt("setLocalAddress no args", () => r.setLocalAddress());
  attempt("setLocalAddress ipv6 bad", () => r.setLocalAddress("127.0.0.1", "nope"));
  attempt("setLocalAddress v6 in ipv4", () => r.setLocalAddress("::1"));
  attempt("setLocalAddress two v4", () => r.setLocalAddress("127.0.0.1", "127.0.0.1"));
  attempt("setLocalAddress two v6", () => r.setLocalAddress("::1", "::2"));
  attempt("setLocalAddress mixed", () => r.setLocalAddress("::1", "127.0.0.1"));
  attempt("setLocalAddress empty", () => r.setLocalAddress(""));
  attempt("cancel idle", () => r.cancel());
  attempt("getServers fresh again", () => r.getServers());

  attempt("options timeout too small", () => new dns.Resolver({ timeout: -2 }));
  attempt("options tries too small", () => new dns.Resolver({ tries: 0 }));
  attempt("options timeout fraction", () => new dns.Resolver({ timeout: 1.5 }));
  attempt("options maxTimeout negative", () => new dns.Resolver({ maxTimeout: -1 }));
  attempt("options ok", () => new dns.Resolver({ timeout: 1000, tries: 2, maxTimeout: 5000 }) instanceof dns.Resolver);

  const p = new PromiseResolver();
  console.log("promises instanceof", p instanceof PromiseResolver, p instanceof dns.Resolver);
  console.log("promises lengths", p.resolve4.length, p.resolve.length, p.getServers.length, p.setServers.length);
  console.log("promises fresh servers", JSON.stringify(p.getServers()));
  p.setServers([server]);
  console.log("promises set", masked(p.getServers(), port));
  dns.promises.setDefaultResultOrder("ipv4first");
  console.log("promises order", dns.promises.getDefaultResultOrder());
  dns.promises.setDefaultResultOrder("verbatim");
  console.log("dns resolver unaffected", JSON.stringify(r.getServers()));

  r.setServers([server]);
  await new Promise<void>((resolve) => {
    r.resolve4("a.test", { ttl: true }, (err, addrs) => {
      console.log("resolver query", err === null ? JSON.stringify(addrs) : err.code);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    r.resolve("a.test", "A", (err, addrs) => {
      console.log("resolver resolve", err === null ? JSON.stringify(addrs) : err.code);
      resolve();
    });
  });
  const viaPromise = await p.resolve4("a.test");
  console.log("promises query", JSON.stringify(viaPromise));

  // setLocalAddress picks the source the queries leave from.
  r.setLocalAddress("127.0.0.2");
  await new Promise<void>((resolve) => {
    r.resolve4("a.test", (err, addrs) => {
      console.log("local source", err === null ? JSON.stringify(addrs) : err.code, lastSource);
      resolve();
    });
  });

  // A failing query calls back with the error alone: an untyped callback sees
  // Node's one-argument call, and a typed result parameter takes the same
  // placeholder a statically typed dns call supplies.
  const dead = new dns.Resolver();
  dead.setServers(["127.0.0.1:1"]);
  await new Promise<void>((resolve) => {
    dead.resolve4("dead.test", (err: unknown, addrs: unknown): void => {
      console.log("dead port dyn", (err as NodeJS.ErrnoException).code, addrs === undefined);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    dead.resolve4("dead.test", (err, addrs) => {
      console.log("dead port typed", err === null ? JSON.stringify(addrs) : err.code);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    dead.resolve("dead.test", "TXT", (err, records) => {
      console.log("dead port resolve", err === null ? JSON.stringify(records) : err.code);
      resolve();
    });
  });

  udp.close();
  console.log("done");
}
