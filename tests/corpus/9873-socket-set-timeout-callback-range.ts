// socket.setTimeout(ms, callback) checks `ms` when it is called: a value
// out of range throws ERR_OUT_OF_RANGE from the call itself, so the
// statement after it does not run and a `try` around the call catches it.
import * as net from "node:net";

const server = net.createServer((socket) => {
  socket.end();
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as net.AddressInfo;
  const socket = net.connect(port, "127.0.0.1");
  const fired = (): void => {
    console.log("timeout fired");
  };
  for (const ms of [-1, Number.NaN, 25]) {
    let after = false;
    try {
      socket.setTimeout(ms, fired);
      after = true;
    } catch (error) {
      const e = error as Error & { code?: string };
      console.log(`${ms}: ${e.name} ${e.code}`, "statement after the call ran:", after);
      continue;
    }
    console.log(`${ms}: no error`, "statement after the call ran:", after);
  }
  socket.on("close", () => {
    console.log("closed");
    server.close();
  });
  socket.resume();
});
