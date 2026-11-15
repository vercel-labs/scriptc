// net.connect / net.createConnection with arguments whose shape only the
// run time knows follow Node's normalizeArgs and Socket.prototype.connect
// ladder: the port (or path), the host, the options bag, and the trailing
// listener are read from the values, and every validation error — missing
// arguments, the port range, the options properties' types and ranges, the
// signal contract — is the one Node throws. The last part connects to a
// server this process listens on, so the dynamic lane dials for real.
"use strict";
const net = require("net");

function show(label, fn) {
  try {
    const value = fn();
    const kind = typeof value;
    console.log(label, "=>", kind);
  } catch (err) {
    console.log(label, "THROW", err.name, err.code, JSON.stringify(err.message));
  }
}

function quiet(socket) {
  if (socket && typeof socket.on === "function") socket.on("error", () => {});
  return socket;
}

// The values arrive from a helper whose results are untyped.
const raw = JSON.parse(
  '{"none":null,"zero":0,"text":"abc","port":0,"host":5,"neg":-1,"big":65536,"frac":1.5}',
);

show("connect()", () => quiet(net.connect()));
show("connect(undefined)", () => quiet(net.connect(raw.missing)));
show("connect(null)", () => quiet(net.connect(raw.none)));
show("connect({})", () => quiet(net.connect({})));
show("connect({port:undefined})", () => quiet(net.connect({ port: raw.missing })));
show("connect({host})", () => quiet(net.connect({ host: "127.0.0.1" })));
show("connect(negative)", () => quiet(net.connect(raw.neg)));
show("connect(too big)", () => quiet(net.connect(raw.big)));
show("connect(fraction)", () => quiet(net.connect(raw.frac)));
show("connect(NaN)", () => quiet(net.connect(NaN)));
show("connect(boolean)", () => quiet(net.connect(true)));
show("connect(non-numeric string)", () => quiet(net.connect(raw.text)));
show("connect({port:-1})", () => quiet(net.connect({ port: raw.neg })));
show("connect({port:'abc'})", () => quiet(net.connect({ port: raw.text })));
show("connect({port,host:5})", () => quiet(net.connect({ port: raw.port, host: raw.host })));
show("connect({path:5})", () => quiet(net.connect({ path: raw.host })));
show("connect({path:null})", () => quiet(net.connect({ path: null })));
show("connect({port,timeout:-1})", () =>
  quiet(net.connect({ port: raw.port, timeout: raw.neg })),
);
show("connect({port,timeout:'5'})", () =>
  quiet(net.connect({ port: raw.port, timeout: "5" })),
);
show("connect({port,signal:'x'})", () =>
  quiet(net.connect({ port: raw.port, signal: "x" })),
);
show("connect({port,fd:'x'})", () => quiet(net.connect({ port: raw.port, fd: "x" })));
show("connect({port,blockList:5})", () =>
  quiet(net.connect({ port: raw.port, blockList: 5 })),
);
show("connect({port,typeOfService:300})", () =>
  quiet(net.connect({ port: raw.port, typeOfService: 300 })),
);
show("connect({port,keepAliveInitialDelay:'x'})", () =>
  quiet(net.connect({ port: raw.port, keepAliveInitialDelay: "x" })),
);
show("connect({port,localAddress:5})", () =>
  quiet(net.connect({ port: raw.port, localAddress: raw.host })),
);
show("connect({port,localPort:'x'})", () =>
  quiet(net.connect({ port: raw.port, localPort: "x" })),
);
show("connect(port, null bytes host)", () => quiet(net.connect(80, "x\u0000y")));
show("connect({port,autoSelectFamily:'x'})", () =>
  quiet(net.connect({ port: raw.port, autoSelectFamily: "x" })),
);
show("connect({port,attemptTimeout:0})", () =>
  quiet(net.connect({ port: raw.port, autoSelectFamilyAttemptTimeout: 0 })),
);
// inspect's spelling keeps the sign of negative zero in the Received text
show("connect({port,attemptTimeout:-0})", () =>
  quiet(net.connect({ port: raw.port, autoSelectFamilyAttemptTimeout: -0 })),
);
show("connect({port,family:5})", () =>
  quiet(net.connect({ port: raw.port, family: raw.host })),
);
show("connect({port,hints:99})", () =>
  quiet(net.connect({ port: raw.port, hints: 99 })),
);
show("connect({port,lookup:5})", () =>
  quiet(net.connect({ port: raw.port, lookup: raw.host })),
);
show("createConnection({port:'abc'})", () =>
  quiet(net.createConnection({ port: raw.text })),
);
show("createConnection()", () => quiet(net.createConnection()));

// The computed-key options bag (the invalid-input probes' spelling) is
// walked as a value too.
const portKey = ["po", "rt"].join("");
show("connect({[port]:-1})", () => quiet(net.connect({ [portKey]: raw.neg })));
show("connect({[port]:'abc'})", () => quiet(net.connect({ [portKey]: raw.text })));

// normalizeArgs's `typeof arg0 === "object"` test takes an array, a view or
// a socket handle as the options bag too; none of them carries a port or a
// path, so the missing-argument error is the one Node reports.
show("connect([])", () => quiet(net.connect([])));
show("connect([80])", () => quiet(net.connect([80])));
show("connect(new Uint8Array(2))", () => quiet(net.connect(new Uint8Array(2))));
{
  const bound = new net.BoundSocket({});
  show("connect(boundSocket)", () => quiet(net.connect(bound)));
  bound.close();
}

// A real dial through the dynamic lane: the listener is the last argument,
// the port comes back from the server's own address.
const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    console.log("server got", JSON.stringify(chunk));
    socket.end("pong");
  });
});
server.on("error", () => {});
server.listen(0, "127.0.0.1", () => {
  const info = server.address();
  console.log("listening", server.listening, typeof info.port, info.address);
  const client = net.connect(info.port, "127.0.0.1", () => {
    console.log("client connected", client.remoteAddress, client.remotePort === info.port);
    client.write("ping");
  });
  client.setEncoding("utf8");
  client.on("data", (chunk) => {
    console.log("client got", JSON.stringify(chunk));
    client.end();
  });
  client.on("close", () => {
    server.close(() => console.log("closed"));
  });
});
