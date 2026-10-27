// tls.connect's timeout option arms the socket's inactivity timeout
// before it connects, so a handshake the peer never answers emits
// 'timeout'. Node applies it only when truthy, so 0 and NaN arm nothing,
// and setTimeout's msecs checks throw from tls.connect for a value that is
// not a number, negative, or not finite.
import * as net from "node:net";
import * as tls from "node:tls";

// The server reads (and ignores) what arrives, so each connection closes
// when its client is destroyed.
const silent = net.createServer((socket) => {
  socket.resume();
});

function attempt(port: number, label: string, timeout: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    let socket: tls.TLSSocket;
    try {
      socket = tls.connect({ host: "127.0.0.1", port, timeout: timeout as any });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.log(label, err.name, err.code, err.message);
      resolve();
      return;
    }
    const fallback = setTimeout(() => {
      console.log(label, "no timeout event");
      socket.destroy();
      resolve();
    }, 300);
    socket.on("timeout", () => {
      console.log(label, "timeout");
      clearTimeout(fallback);
      socket.destroy();
      resolve();
    });
    socket.on("error", (err) => console.log(label, "error", (err as NodeJS.ErrnoException).code));
  });
}

silent.listen(0, "127.0.0.1", async () => {
  const port = (silent.address() as net.AddressInfo).port;
  await attempt(port, "50ms", 50);
  await attempt(port, "fractional", 30.7);
  await attempt(port, "zero", 0);
  await attempt(port, "nan", NaN);
  await attempt(port, "negative", -1);
  await attempt(port, "infinite", Infinity);
  await attempt(port, "string", "x");
  silent.close();
});
