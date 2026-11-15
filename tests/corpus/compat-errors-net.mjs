// The errors of node:net, node:dgram and the HTTP client as Node's errors
// chapter documents them: the system errors of a refused connection, a
// failed lookup and a taken address, with errno, code, syscall and the
// address and port or the hostname; ERR_SERVER_NOT_RUNNING,
// ERR_SOCKET_CLOSED_BEFORE_CONNECTION, ERR_SOCKET_ALREADY_BOUND and
// ERR_SOCKET_DGRAM_NOT_RUNNING. Each case prints the class, name, code
// and message, and the own property names where the shape is the point.
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const kind = (e) => (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof Error ? "Error" : typeof e);
const names = (e) => Object.getOwnPropertyNames(e).filter((name) => name !== "stack").join();
function show(label, e, port) {
  const message = port === undefined ? e.message : e.message.replace(String(port), "PORT");
  console.log(label, [kind(e), e.name, e.code, message].join(" | "));
}
function shape(label, fn) {
  try {
    fn();
    console.log(label, "no throw");
  } catch (e) {
    show(label, e);
  }
}

// A refused connection: net, http and https report the same system error.
await new Promise((resolve) => {
  const socket = net.connect(1, "127.0.0.1");
  socket.on("error", (e) => {
    show("net connect", e);
    console.log(names(e), e.errno < 0, e.syscall, e.address, e.port);
  });
  socket.on("close", (hadError) => {
    console.log("net close", hadError);
    resolve(undefined);
  });
});
await new Promise((resolve) => {
  const request = http.request({ host: "127.0.0.1", port: 1 });
  request.on("error", (e) => {
    show("http connect", e);
    console.log(names(e), e.errno < 0, e.syscall, e.address, e.port);
    resolve(undefined);
  });
  request.end();
});
await new Promise((resolve) => {
  const request = https.get({ host: "127.0.0.1", port: 1 });
  request.on("error", (e) => {
    show("https connect", e);
    console.log(names(e), e.errno < 0, e.syscall, e.address, e.port);
    resolve(undefined);
  });
});

// A name that does not resolve: the lookup's error, with the hostname.
await new Promise((resolve) => {
  const socket = net.connect({ host: "host.invalid", port: 1 });
  socket.on("error", (e) => {
    show("net lookup", e);
    console.log(names(e), typeof e.errno, e.syscall, e.hostname);
    resolve(undefined);
  });
});
await new Promise((resolve) => {
  const request = http.get("http://host.invalid/");
  request.on("error", (e) => {
    show("http lookup", e);
    console.log(names(e), typeof e.errno, e.syscall, e.hostname);
    resolve(undefined);
  });
});

// An address in use: the server's 'error' and the datagram socket's.
await new Promise((resolve) => {
  const first = net.createServer();
  first.listen(0, "127.0.0.1", () => {
    const port = first.address().port;
    const second = net.createServer();
    second.on("error", (e) => {
      show("net listen", e, port);
      console.log(e.errno < 0, e.syscall, e.address, e.port === port);
      first.close(resolve);
    });
    second.listen(port, "127.0.0.1");
  });
});
await new Promise((resolve) => {
  const first = dgram.createSocket("udp4");
  first.bind(0, "127.0.0.1", () => {
    const port = first.address().port;
    const second = dgram.createSocket("udp4");
    second.on("error", (e) => {
      show("dgram bind", e, port);
      console.log(e.errno < 0, e.syscall);
      second.close();
      first.close(() => resolve(undefined));
    });
    second.bind(port, "127.0.0.1");
  });
});
await new Promise((resolve) => {
  const socket = dgram.createSocket("udp4");
  socket.send("x", 1, "host.invalid", (e) => {
    show("dgram send lookup", e);
    console.log(names(e), typeof e.errno, e.syscall, e.hostname);
    socket.close(() => resolve(undefined));
  });
});

// Datagram socket states.
await new Promise((resolve) => {
  const socket = dgram.createSocket("udp4");
  socket.bind(0, "127.0.0.1", () => {
    shape("dgram bound", () => socket.bind(0));
    socket.close(() => {
      shape("dgram closed send", () => socket.send("x", 1, "127.0.0.1"));
      resolve(undefined);
    });
  });
  shape("dgram binding", () => socket.bind(0));
});

// A server that is not running: close() reports it to its callback,
// before listen, while closing, and after the close.
await new Promise((resolve) => net.createServer().close((e) => (show("net never listened", e), resolve(undefined))));
await new Promise((resolve) => http.createServer().close((e) => (show("http never listened", e), resolve(undefined))));
await new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    server.close((e) => {
      console.log("first close", e === undefined);
      server.close((again) => (show("closed", again), resolve(undefined)));
    });
    server.close((e) => show("closing", e));
  });
});

// A write queued while the socket connects, and the connection is
// refused: the socket's 'error', then the write's callback, then 'close'.
await new Promise((resolve) => {
  const socket = net.connect(1, "127.0.0.1");
  socket.on("error", (e) => show("refused", e));
  console.log(socket.write("x", (e) => show("write callback", e)));
  socket.on("close", (hadError) => {
    console.log("close", hadError);
    resolve(undefined);
  });
});

// A write queued while the socket connects, then destroy(): the write's
// callback receives the error and nothing else is reported.
await new Promise((resolve) => {
  const server = net.createServer((connection) => connection.end());
  server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1");
    socket.on("error", (e) => show("unexpected error", e));
    console.log(socket.write("x", (e) => show("write callback", e)));
    socket.destroy();
    socket.on("close", (hadError) => {
      console.log("close", hadError);
      server.close(resolve);
    });
  });
});
