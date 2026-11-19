// new net.Socket(): the constructor's state, its connect() forms (port,
// options, path and the no-argument error), the EALREADY error of a second
// connect, and allowHalfOpen.
import * as net from "node:net";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function attempt(label: string, op: () => unknown): void {
  try {
    op();
    console.log(label, "ok");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message);
  }
}

const server = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    console.log("server got", String(chunk));
    socket.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as net.AddressInfo;
const port = address.port;

// connect(port, host, listener) and end(data, encoding, callback).
await new Promise<void>((resolve) => {
  const socket = new net.Socket();
  console.log(
    "fresh",
    socket.connecting,
    socket.destroyed,
    socket.pending,
    socket.readyState,
    socket.timeout,
    JSON.stringify(socket.address()),
  );
  socket.on("close", (hadError) => {
    console.log("close", hadError);
    resolve();
  });
  socket.connect(port, "127.0.0.1", () => {
    const local = socket.address() as { family?: string };
    console.log(
      "connected",
      socket.readyState,
      socket.remoteAddress,
      socket.remotePort === port,
      local.family,
    );
    socket.end("bye", "utf8", () => console.log("ended"));
  });
});

// connect(options) and connect(path).
await new Promise<void>((resolve) => {
  const socket = new net.Socket();
  socket.on("close", () => resolve());
  socket.connect({ port, host: "127.0.0.1" }, () => {
    console.log("options connected", socket.readyState);
    socket.destroy();
  });
});

const unixPath = join(tmpdir(), "scriptc-net-socket-construct.sock");
rmSync(unixPath, { force: true });
await new Promise<void>((resolve) => {
  const unixServer = net.createServer((socket) => socket.end());
  unixServer.listen(unixPath, () => {
    const socket = new net.Socket();
    socket.on("close", () => {
      console.log("path closed");
      unixServer.close();
      resolve();
    });
    socket.connect(unixPath, () => {
      console.log("path connected");
      socket.destroy();
    });
  });
});

// Node's missing-argument and EALREADY errors.
const bare = new net.Socket();
attempt("no arguments", () => bare.connect());
bare.destroy();

await new Promise<void>((resolve) => {
  const socket = new net.Socket();
  socket.on("error", (e) => {
    const err = e as NodeJS.ErrnoException;
    console.log("second connect", err.code, err.message.startsWith("connect EALREADY"));
  });
  // Node's stream auto-destroys on the emitted error, so 'close' follows
  // and the first dial never completes.
  socket.on("close", (hadError) => {
    console.log("second connect close", hadError);
    resolve();
  });
  socket.connect(port, "127.0.0.1");
  socket.connect(port, "127.0.0.1");
});

// allowHalfOpen: the peer's FIN does not end the write half.
await new Promise<void>((resolve) => {
  const halfServer = net.createServer((socket) => socket.end("half"));
  halfServer.listen(0, "127.0.0.1", () => {
    const socket = new net.Socket({ allowHalfOpen: true });
    socket.on("data", (chunk) => console.log("half data", String(chunk)));
    socket.on("end", () => {
      console.log("half end writable", socket.writable);
      socket.end(() => console.log("half finished"));
    });
    socket.on("close", () => {
      halfServer.close();
      resolve();
    });
    socket.connect((halfServer.address() as net.AddressInfo).port, "127.0.0.1");
  });
});

// destroy(error): the 'error' event carries that Error, then 'close' with
// hadError.
await new Promise<void>((resolve) => {
  const socket = new net.Socket();
  const failure = new Error("expected");
  socket.on("error", (e) => console.log("destroy error", (e as Error).message));
  socket.on("close", (hadError) => {
    console.log("destroy close", hadError);
    resolve();
  });
  socket.connect(port, "127.0.0.1", () => socket.destroy(failure));
});

server.close();
