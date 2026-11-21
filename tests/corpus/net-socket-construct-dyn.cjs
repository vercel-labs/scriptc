// The checked-dynamic lane of new net.Socket(): an idle handle that connect()
// dials, with allowHalfOpen keeping the write half open after the peer's FIN.
"use strict";
const net = require("node:net");

const describe = (socket) =>
  JSON.stringify({
    address: socket.address(),
    connecting: socket.connecting,
    destroyed: socket.destroyed,
    pending: socket.pending,
    readable: socket.readable,
    writable: socket.writable,
    allowHalfOpen: socket.allowHalfOpen,
  });

const idle = () =>
  new Promise((resolve) => {
    console.log("idle", describe(new net.Socket()));
    console.log("half open", describe(new net.Socket({ allowHalfOpen: true })));
    const controller = new AbortController();
    const signalled = new net.Socket({ signal: controller.signal });
    /* the listener joins after abort(): Node's deferred error reaches it */
    controller.abort();
    signalled.on("error", (error) => {
      console.log("aborted error", error.code, error.message);
    });
    setImmediate(() => {
      console.log("aborted", signalled.destroyed, signalled.readable, signalled.writable);
      resolve();
    });
  });

const halfOpen = () =>
  new Promise((resolve) => {
    const server = net.createServer((peer) => {
      peer.on("error", () => {});
      peer.on("data", () => {});
      peer.end("bye");
    });
    server.listen(0, "127.0.0.1", () => {
      const socket = new net.Socket({ allowHalfOpen: true });
      const events = [];
      socket.on("data", () => events.push("data"));
      socket.on("end", () => {
        events.push("end");
        events.push(`write:${socket.write("after the fin")}`);
        socket.end();
      });
      socket.on("close", () => {
        events.push("close");
        console.log("half open", events.join(","));
        server.close();
        resolve();
      });
      socket.on("error", (error) => events.push(`error:${error.message}`));
      socket.connect(server.address().port, "127.0.0.1");
    });
  });

(async () => {
  await idle();
  await halfOpen();
})();
