// net.BoundSocket: a socket bound before any server adopts it. Node's class
// validates its options in order, reads the bound endpoint through address()
// and fd(), reports a pipe bind through isPipe, closes and disposes of an
// un-adopted handle, and hands its descriptor to exactly one server through
// listen(bound). Once adopted, the BoundSocket's own methods throw
// ERR_SOCKET_HANDLE_ADOPTED, and the server reports the same endpoint the
// handle had bound.
import * as net from "node:net";
import { inspect } from "node:util";

type BindError = NodeJS.ErrnoException & { address?: string; port?: number };

function attempt(label: string, fn: () => unknown): void {
  try {
    const value = fn();
    console.log(label, "ok", typeof value);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log(label, "threw", e.name, e.code, e.message);
  }
}

const tcp = new net.BoundSocket({ port: 0, host: "127.0.0.1" });
const address = tcp.address() as any;
console.log("tcp", typeof address, address.family, address.address, address.port > 0);
const fd = tcp.fd() as any;
console.log("fd", typeof fd, fd > 0, fd === (tcp.fd() as any));
console.log("isPipe", tcp.isPipe);
console.log("identity", tcp.address() === tcp.address());
console.log("inspect", inspect(tcp), JSON.stringify(tcp));
console.log("instanceof", tcp instanceof net.BoundSocket);
tcp.close();

attempt("closed address", () => (tcp.address() as any));
attempt("closed fd", () => tcp.fd());
attempt("closed close", () => tcp.close());
console.log("closed dispose", (tcp as any)[Symbol.dispose]());

const v6 = new net.BoundSocket({ port: 0, host: "::1", ipv6Only: true });
const v6Address = v6.address() as any;
console.log("v6", v6Address.family, v6Address.address === "::1", v6Address.port > 0, v6.isPipe);
v6.close();

const any4 = new net.BoundSocket({ port: 0 });
const any4Address = any4.address() as any;
console.log("default v4", any4Address.family, any4Address.address);
any4.close();

const any6 = new net.BoundSocket({ port: 0, ipv6Only: true });
const any6Address = any6.address() as any;
console.log("default v6", any6Address.family, any6Address.address);
any6.close();

const stringPort = new net.BoundSocket({ port: "0", host: "127.0.0.1" });
console.log("string port", (stringPort.address() as any).port > 0);
stringPort.close();

const reuseA = new net.BoundSocket({ port: 0, host: "127.0.0.1", reusePort: true });
const reusePort = (reuseA.address() as any).port;
const reuseB = new net.BoundSocket({ port: reusePort, host: "127.0.0.1", reusePort: true });
console.log("reusePort", (reuseB.address() as any).port === reusePort);
reuseA.close();
reuseB.close();

{
  using disposable = new net.BoundSocket({ port: 0, host: "127.0.0.1" });
  const shown = disposable.address() as any;
  console.log("using", disposable.isPipe, shown.family, shown.port > 0);
}
console.log("using done");

attempt("bad port", () => new net.BoundSocket({ port: 70000 }));
attempt("bad host", () => new net.BoundSocket({ port: 0, host: "localhost" }));
attempt("bad ipv6Only", () => new net.BoundSocket({ ipv6Only: "yes" } as any));
attempt("bad reusePort", () => new net.BoundSocket({ reusePort: 1 } as any));
attempt("bad path type", () => new net.BoundSocket({ path: 5 } as any));
attempt("null path", () => new net.BoundSocket({ path: null } as any));
attempt("exclusive", () => new net.BoundSocket({ path: "/tmp/scriptc-bound.sock", port: 0 }));
attempt("bad options", () => new net.BoundSocket(5 as any));

const bound = new net.BoundSocket({ port: 0, host: "127.0.0.1" });
const boundPort = (bound.address() as any).port as number;
const server = net.createServer((socket) => socket.end("hello"));
server.listen(bound, () => {
  const info = server.address() as net.AddressInfo;
  console.log("adopted", info.family, info.address, info.port === boundPort, server.listening);
  attempt("adopted address", () => (bound.address() as any));
  attempt("adopted fd", () => bound.fd());
  attempt("adopted close", () => bound.close());
  console.log("adopted dispose", (bound as any)[Symbol.dispose]());
  attempt("listen again", () => server.listen(bound));
  attempt("listen number", () => server.listen(0));
  const rival = net.createServer();
  rival.on("error", (err: NodeJS.ErrnoException) => console.log("rival error", err.code));
  attempt("adopt consumed", () => rival.listen(bound));
  try {
    new net.BoundSocket({ port: info.port, host: "127.0.0.1" });
    console.log("duplicate ok");
  } catch (err) {
    const e = err as BindError;
    console.log(
      "duplicate",
      e.name,
      e.code,
      e.message.replace(String(info.port), "<port>"),
      e.errno,
      e.syscall,
      e.address,
      e.port === info.port,
    );
  }
  try {
    new net.BoundSocket({ port: 0, host: "8.8.8.8" });
    console.log("unavailable ok");
  } catch (err) {
    const e = err as BindError;
    console.log("unavailable", e.name, e.code, e.message, e.errno, e.syscall, e.address);
  }
  const client = net.createConnection(info.port, "127.0.0.1");
  client.on("data", (chunk) => console.log("client", chunk.toString()));
  client.on("close", () => server.close(() => console.log("server closed")));
});
