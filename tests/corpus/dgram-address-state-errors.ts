// address() and remoteAddress() across the socket's states: getsockname's
// EBADF before bind, ERR_SOCKET_DGRAM_NOT_CONNECTED for an unconnected
// remote read, and "Not running" after close().
import * as dgram from "node:dgram";

function attempt(label: string, op: () => unknown): void {
  try {
    const value = op() as dgram.AddressInfo;
    console.log(label, "ok", value.address, value.family, typeof value.port);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message, err.errno, err.syscall);
  }
}

const fresh = dgram.createSocket("udp4");
attempt("unbound address", () => fresh.address());
attempt("unbound remote", () => fresh.remoteAddress());
fresh.close();
attempt("closed address", () => fresh.address());
attempt("closed remote", () => fresh.remoteAddress());

await new Promise<void>((resolve) => {
  const socket = dgram.createSocket("udp4");
  socket.bind(0, "127.0.0.1", () => {
    attempt("bound remote", () => socket.remoteAddress());
    socket.close();
    attempt("closing address", () => socket.address());
    resolve();
  });
});
