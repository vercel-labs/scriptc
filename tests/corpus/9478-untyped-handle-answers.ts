// What native handles answer when they are used through an untyped value:
// a child process's ref() and unref() answer undefined (a socket's answer the
// socket), and a 'close' listener registered on a socket is called with the
// hadError boolean, false after a clean end and true after a failed connect.
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";

const child: any = spawn("sh", ["-c", "exit 4"], { stdio: "ignore" });
const unreferenced = child.unref();
const referenced = child.ref();
console.log("child", typeof unreferenced, typeof referenced, referenced === child, JSON.stringify([unreferenced, referenced]));
child.on("exit", (code: unknown) => {
  console.log("child exit", code);
  sockets();
});

function describe(args: unknown[]): string {
  return `${args.length} ${args.map((value) => `${typeof value}:${String(value)}`).join(",")}`;
}

function sockets(): void {
  const server = createServer((peer) => {
    peer.on("end", () => peer.end());
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const socket: any = connect(port, "127.0.0.1");
    console.log("socket", socket.ref() === socket, socket.unref() === socket, socket.ref() === socket);
    socket.on("close", (...args: unknown[]) => console.log("close on", describe(args)));
    socket.once("close", (...args: unknown[]) => console.log("close once", describe(args)));
    socket.addListener("close", (hadError: unknown) => {
      console.log("close addListener", hadError);
      server.close(() => refused(port));
    });
    socket.on("connect", () => socket.end());
  });
}

// Nothing listens on the port any more: the connect fails, then the socket closes.
function refused(port: number): void {
  const socket: any = connect(port, "127.0.0.1");
  socket.on("error", (error: { code?: unknown }) => console.log("error", error.code));
  socket.on("close", (...args: unknown[]) => console.log("close after error", describe(args)));
}
