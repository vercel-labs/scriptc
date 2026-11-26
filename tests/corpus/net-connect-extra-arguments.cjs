// socket.connect(string, ...): Node classifies the string — a non-empty
// numeric string in range is the TCP port (with validatePort's synchronous
// ERR_SOCKET_BAD_PORT for the empty and out-of-range forms), anything else is
// a Unix socket path. Every argument expression is evaluated, the last
// argument (with three) or the second (with two) is the callback slot, and a
// slot whose static type is not a function still becomes the listener when
// its run-time value is one.
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const out = [];
const say = (...parts) => out.push(parts.map((part) => String(part)).join(" "));
const codeOf = (err) => String(err && err.code);

const sockPath = path.join(os.tmpdir(), `scr-connect-args-${process.pid}.sock`);
const unixServer = net.createServer((socket) => socket.on("data", () => {}));
const tcpServer = net.createServer((socket) => socket.on("data", () => {}));

const steps = [];
let printed = false;
const run = () => {
  const step = steps.shift();
  if (step === undefined) {
    if (!printed) {
      printed = true;
      console.log(out.join("\n"));
    }
    return;
  }
  step();
};

steps.push(() => {
  const sideEffect = () => {
    say("middle-ran");
    return () => say("third-listener-ran");
  };
  const client = new net.Socket();
  client.on("error", (err) => say("three-args-error", codeOf(err)));
  client.connect(sockPath, () => say("second-listener-ran"), sideEffect());
  setTimeout(() => {
    client.destroy();
    run();
  }, 200);
});

steps.push(() => {
  const client = new net.Socket();
  client.on("error", (err) => say("non-function-second-error", codeOf(err)));
  client.connect(sockPath, "not a listener");
  setTimeout(() => {
    client.destroy();
    run();
  }, 200);
});

steps.push(() => {
  const dynamicListener = /** @type {any} */ (() => say("dynamic-listener-ran"));
  const client = new net.Socket();
  client.on("error", (err) => say("dynamic-listener-error", codeOf(err)));
  client.connect(sockPath, dynamicListener);
  setTimeout(() => {
    client.destroy();
    run();
  }, 200);
});

steps.push(() => {
  // a numeric string port keeps the supplied destination host
  const tcpPort = tcpServer.address().port;
  const client = new net.Socket();
  let connected = false;
  client.on("connect", () => {
    connected = true;
    say("string-port-host", "connected", client.remotePort === tcpPort);
  });
  client.on("error", (err) => say("string-port-host-error", codeOf(err)));
  client.connect(String(tcpPort), "127.0.0.1");
  setTimeout(() => {
    if (!connected) say("string-port-host", "not-connected");
    client.destroy();
    run();
  }, 200);
});

steps.push(() => {
  // ...and dials THAT host: the server listens on 127.0.0.1 only, so the
  // other loopback address is refused instead of being answered locally
  const tcpPort = tcpServer.address().port;
  const client = new net.Socket();
  client.on("error", (err) => {
    say("string-port-other-host", codeOf(err));
    client.destroy();
    run();
  });
  client.connect(String(tcpPort), "127.0.0.2");
  setTimeout(() => {
    client.destroy();
    run();
  }, 300);
});

steps.push(() => {
  const tcpPort = tcpServer.address().port;
  const client = new net.Socket();
  let connected = false;
  client.on("connect", () => {
    connected = true;
    say("numeric-string", "connected", client.remotePort === tcpPort);
  });
  client.on("error", (err) => say("numeric-string-error", codeOf(err)));
  client.connect(String(tcpPort));
  setTimeout(() => {
    if (!connected) say("numeric-string", "not-connected");
    client.destroy();
    tcpServer.close(() => run());
  }, 200);
});

steps.push(() => {
  for (const bad of ["", "   ", "70000"]) {
    try {
      const client = new net.Socket();
      client.connect(bad);
      say("bad-port-string", JSON.stringify(bad), "accepted");
      client.destroy();
    } catch (err) {
      say("bad-port-string", JSON.stringify(bad), codeOf(err), JSON.stringify(err.message));
    }
  }
  run();
});

steps.push(() => {
  const client = new net.Socket();
  client.on("error", (err) => {
    say("missing-path", codeOf(err));
    client.destroy();
    run();
  });
  client.connect(`${sockPath}.missing`);
  setTimeout(() => {
    client.destroy();
    run();
  }, 500);
});

steps.push(() => {
  unixServer.close(() => {
    try {
      fs.unlinkSync(sockPath);
    } catch {}
    say("closed");
    run();
  });
});

unixServer.listen(sockPath, () => {
  tcpServer.listen(0, "127.0.0.1", () => run());
});
