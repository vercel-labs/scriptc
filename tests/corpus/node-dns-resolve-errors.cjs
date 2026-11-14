// dns's stub resolver's failures: the DNSException's fields for each rcode,
// the transport failures (refused, timeout, cancel), and the argument
// errors the call-time checks throw. The responder answers by name; the
// resolver's servers point at it.
const dns = require("node:dns");
const { createSocket } = require("node:dgram");

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
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

function reply(query, rcode) {
  const end = questionEnd(query);
  const head = Buffer.alloc(12);
  query.copy(head, 0, 0, 2);
  head.writeUInt16BE(0x8400 | rcode, 2);
  head.writeUInt16BE(1, 4);
  return Buffer.concat([head, query.slice(12, end)]);
}

const udp = createSocket("udp4");
udp.on("message", (msg, rinfo) => {
  const name = questionName(msg);
  let rcode = 0;
  if (name === "nxdomain.test") rcode = 3;
  else if (name === "nodata.test") rcode = 0;
  else if (name === "servfail.test") rcode = 2;
  else if (name === "refused.test") rcode = 5;
  else if (name === "blackhole.test") return;
  else rcode = 3;
  udp.send(reply(msg, rcode), rinfo.port, rinfo.address);
});

/* The responder's port is ephemeral, so it never reaches the compared
 * output: the servers a set makes read back as ":port". */
function mask(text, p) {
  return text.split(":" + p).join(":port");
}

function report(label, err) {
  if (err === null) {
    console.log(label, "ok");
    return;
  }
  console.log(
    label,
    JSON.stringify({
      name: err.name,
      message: err.message,
      code: err.code,
      errno: err.errno === undefined ? "undefined" : String(err.errno),
      syscall: err.syscall,
      hostname: err.hostname,
      keys: Object.keys(err).join(","),
    }),
  );
}

function attempt(label, fn) {
  try {
    const v = fn();
    console.log(label, "sync", v === undefined ? "undefined" : String(v));
  } catch (e) {
    console.log(label, "throw", e.name, e.code, JSON.stringify(e.message));
  }
}

function rcodeCase(label, name) {
  return new Promise((resolve) => {
    dns.resolve4(name, (err, addrs) => {
      report(label, err);
      resolve(undefined);
    });
  });
}

udp.bind(0, "127.0.0.1", () => {
  const port = udp.address().port;
  dns.setServers(["127.0.0.1:" + port]);
  run(port);
});

async function run(port) {
  await rcodeCase("nxdomain", "nxdomain.test");
  await rcodeCase("nodata", "nodata.test");
  await rcodeCase("servfail", "servfail.test");
  await rcodeCase("refused", "refused.test");
  await rcodeCase("empty name", "");
  await rcodeCase("bad chars", "bad name.test");

  // A port with no listener: the kernel's port-unreachable is ECONNREFUSED.
  const closed = createSocket("udp4");
  await new Promise((resolve) => closed.bind(0, "127.0.0.1", () => resolve(undefined)));
  const deadPort = closed.address().port;
  closed.close();
  dns.setServers(["127.0.0.1:" + deadPort]);
  await rcodeCase("refused port", "a.test");

  // The responder answers nothing for blackhole.test: the resolver's
  // timeout is the whole query's.
  dns.setServers(["127.0.0.1:" + port]);
  const timed = new dns.Resolver({ timeout: 50, tries: 1 });
  timed.setServers(["127.0.0.1:" + port]);
  await new Promise((resolve) => {
    timed.resolve4("blackhole.test", (err, addrs) => {
      report("timeout", err);
      resolve(undefined);
    });
  });

  // cancel() settles the resolver's live queries.
  const cancellable = new dns.Resolver();
  cancellable.setServers(["127.0.0.1:" + port]);
  await new Promise((resolve) => {
    cancellable.resolve4("blackhole.test", (err, addrs) => {
      report("cancel", err);
      resolve(undefined);
    });
    cancellable.cancel();
    cancellable.cancel();
  });

  // resolve()'s rrtype is checked at call time.
  await new Promise((resolve) => {
    attempt("invalid rrtype", () => dns.resolve("a.test", "BOGUS", () => {}));
    attempt("lowercase rrtype", () => dns.resolve("a.test", "mx", () => {}));
    attempt("numeric rrtype", () => dns.resolve("a.test", 42, () => {}));
    resolve(undefined);
  });

  attempt("reverse not an address", () => dns.reverse("not-an-ip", () => {}));
  attempt("reverse empty", () => dns.reverse("", () => {}));
  const longName = "a".repeat(64) + ".test";
  await new Promise((resolve) => {
    dns.resolve4(longName, (err, addrs) => {
      report("label too long", err);
      resolve(undefined);
    });
  });
  attempt("missing callback", () => dns.resolve4("a.test"));
  attempt("bad callback", () => dns.resolve4("a.test", 42));

  attempt("setServers not an array", () => dns.setServers("127.0.0.1"));
  attempt("setServers bad entry", () => dns.setServers(["not-an-ip"]));
  const badEntry = [42];
  attempt("setServers entry type", () => dns.setServers(badEntry));
  console.log("servers kept", mask(JSON.stringify(dns.getServers()), port));

  // The promise form: argument errors throw synchronously, failures reject.
  attempt("promises invalid rrtype", () => dns.promises.resolve("a.test", "BOGUS"));
  attempt("promises bad callback-less name", () => dns.promises.resolve4(42));
  const rejected = dns.promises.resolve4("nxdomain.test");
  await rejected.then(
    (v) => console.log("promise nxdomain", "resolved", JSON.stringify(v)),
    (e) => report("promise nxdomain", e),
  );

  udp.close();
  console.log("done");
}
