// new net.Socket([options]): an idle socket — no descriptor, address() is an
// empty object and pending is true — that connect() then dials; allowHalfOpen
// keeps the write half open after the peer's FIN (a write still goes out),
// and an aborted signal destroys it on the next tick.
import * as net from "node:net";

const describe = (socket: net.Socket): string =>
  JSON.stringify({
    address: socket.address(),
    connecting: socket.connecting,
    destroyed: socket.destroyed,
    pending: socket.pending,
    readable: socket.readable,
    writable: socket.writable,
    allowHalfOpen: socket.allowHalfOpen,
    timeout: socket.timeout,
  });

const idle = (): Promise<void> =>
  new Promise<void>((resolve) => {
    console.log("idle", describe(new net.Socket()));
    console.log("half open", describe(new net.Socket({ allowHalfOpen: true })));
    const ignored = new net.Socket(null as unknown as net.SocketConstructorOpts);
    console.log("ignored", ignored.pending);
    ignored.destroy();
    const controller = new AbortController();
    const signalled = new net.Socket({ signal: controller.signal });
    controller.abort();
    setImmediate(() => {
      console.log("aborted", signalled.destroyed, signalled.readable, signalled.writable);
      resolve();
    });
  });

const dial = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const server = net.createServer((peer) => {
      peer.on("error", () => {});
      peer.on("data", () => {});
      peer.end("bye");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      const socket = new net.Socket();
      const events: string[] = [];
      socket.on("connect", () => events.push(`connect:${socket.pending}`));
      socket.on("data", () => events.push("data"));
      socket.on("end", () => events.push("end"));
      socket.on("close", () => {
        events.push("close");
        console.log("dial", events.join(","));
        server.close();
        resolve();
      });
      socket.on("error", (error: Error) => events.push(`error:${error.message}`));
      socket.connect(address.port, "127.0.0.1");
    });
  });

const halfOpen = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const server = net.createServer((peer) => {
      peer.on("error", () => {});
      peer.on("data", () => {});
      peer.end("bye");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      const socket = new net.Socket({ allowHalfOpen: true });
      const events: string[] = [];
      socket.on("data", () => events.push("data"));
      socket.on("end", () => {
        events.push("end");
        const accepted = socket.write("after the fin");
        events.push(`write:${accepted}`);
        socket.end();
      });
      socket.on("close", () => {
        events.push("close");
        console.log("half open", events.join(","));
        server.close();
        resolve();
      });
      socket.on("error", (error: Error) => events.push(`error:${error.message}`));
      socket.connect(address.port, "127.0.0.1");
    });
  });

await idle();
await dial();
await halfOpen();
