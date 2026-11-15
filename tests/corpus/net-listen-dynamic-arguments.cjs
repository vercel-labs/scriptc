// server.listen with arguments whose shape only the run time knows follows
// Node's normalizeArgs and Server.prototype.listen ladder: the port, the
// path or the options bag, the backlog, and the trailing listener are read
// from the values, an already-listening server throws
// ERR_SERVER_ALREADY_LISTEN, close([callback]) answers undefined once the
// server closed and ERR_SERVER_NOT_RUNNING when it was not running, and an
// AbortSignal option closes the server it armed.
"use strict";
const net = require("net");

function show(label, fn) {
  try {
    const value = fn();
    const kind = typeof value;
    console.log(label, "=>", kind);
    return value;
  } catch (err) {
    console.log(label, "THROW", err.name, err.code, JSON.stringify(err.message));
    return undefined;
  }
}

// Every server the probes build is closed before the process ends: a
// listening server the probes abandon is never collected, and the
// reference-count audit reports it.
const probes = [];
function server() {
  const s = net.createServer();
  s.on("error", () => {});
  s.on("listening", () => s.unref());
  probes.push(s);
  return s;
}

// The values arrive from a helper whose results are untyped.
const raw = JSON.parse('{"none":null,"zero":0,"host":5,"text":"abc","backlog":"x","key":"exclusive"}');

show("listen(-1)", () => server().listen(-1));
show("listen(65536)", () => server().listen(65536));
show("listen(1.5)", () => server().listen(1.5));
show("listen(NaN)", () => server().listen(NaN));
show("listen({})", () => server().listen({}));
show("listen({port:-1})", () => server().listen({ port: -1 }));
show("listen({port:'abc'})", () => server().listen({ port: raw.text }));
show("listen({path:5})", () => server().listen({ path: raw.host }));
show("listen({port,host:5})", () => server().listen({ port: raw.zero, host: raw.host }));
show("listen({port,signal:'x'})", () =>
  server().listen({ port: raw.zero, signal: "x" }),
);
show("listen({port,backlog:'x'})", () =>
  server().listen({ port: raw.zero, backlog: raw.backlog }),
);
show("listen({port,ipv6Only:1})", () => server().listen({ port: raw.zero, ipv6Only: 1 }));
show("listen({port,exclusive:1})", () => server().listen({ port: raw.zero, exclusive: 1 }));
show("listen({port,reusePort:false})", () =>
  server().listen({ port: raw.zero, reusePort: false }),
);
// A computed key: the bag is read as a value.
const key = raw.key;
show("listen({[key]:1,port})", () => server().listen({ [key]: 1, port: raw.zero }));
show("listen(0, 5)", () => server().listen(0, 5));
show("listen(0,'127.0.0.1','5')", () => server().listen(0, "127.0.0.1", "5"));
show("listen(0,'127.0.0.1',5)", () => server().listen(0, "127.0.0.1", 5));
show("listen(null)", () => server().listen(raw.none));
show("listen(0,null)", () => server().listen(0, raw.none));
show("listen('0')", () => server().listen("0"));
// normalizeArgs's `typeof arg0 === "object"` test takes an array as the
// options bag too; it has no port or path property, so Node's
// ERR_INVALID_ARG_VALUE names the received value.
show("listen([])", () => server().listen([]));
show("listen([5000])", () => server().listen([5000]));

// The probes' servers close here: the ones that started listening stop,
// and the ones that threw during listen still drop their listeners. Nothing
// prints, so Node and the build agree.
for (const s of probes) s.close();

// The lifecycle through the dynamic lane: listen() binds an unused port,
// address() answers the bound record, close(cb) answers undefined, a second
// close answers ERR_SERVER_NOT_RUNNING, and a closed server listens again.
const first = net.createServer();
console.log("listen() returns the server", first.listen() === first);
first.on("listening", () => {
  const info = first.address();
  console.log("listening", first.listening, typeof info.port, info.family, info.address);
  console.log("address keys", Object.keys(info).join(","));
  first.close((err) => {
    console.log("close callback", err === undefined ? "undefined" : err.code);
    console.log("listening after close", first.listening);
    first.close((second) => {
      console.log("second close", second && second.code, second && second.message);
      step();
    });
  });
});

function step() {
  // listen(cb) takes the callback and an unused port; the return value is
  // the server.
  const s = net.createServer();
  const returned = s.listen(() => {
    console.log("listen(cb) listening", s.listening);
    // An already-listening server throws before anything else happens.
    try {
      s.listen(0);
    } catch (err) {
      console.log("double listen", err.code, JSON.stringify(err.message));
    }
    s.close(() => {
      console.log("closed after listen(cb)");
      abortStep();
    });
  });
  console.log("listen(cb) returns the server", returned === s);
}

function abortStep() {
  const controller = new AbortController();
  const s = net.createServer();
  s.listen({ port: 0, signal: controller.signal }, () => {
    console.log("abort signal listening", s.listening);
    controller.abort();
    s.on("close", () => {
      console.log("abort closed", s.listening);
      console.log("done");
    });
  });
}
