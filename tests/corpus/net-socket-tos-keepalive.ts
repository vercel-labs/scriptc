// net.Socket's type-of-service knob (setTypeOfService/getTypeOfService,
// Node's validation ladders and the kernel's ECN masking), the
// setKeepAlive(options) bag, bufferSize, autoSelectFamilyAttemptedAddresses
// on a single-address dial (undefined) and the server back-pointer of an
// accepted socket. The members @types/node does not declare (server,
// getTypeOfService) are read through the checker's `any`, as the runtime
// docs spell them; the process-wide autoSelectFamily switch round-trips.
import * as net from "node:net";
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from "node:net";

setDefaultAutoSelectFamily(false);
console.log("default family", getDefaultAutoSelectFamily());
setDefaultAutoSelectFamily(true);
console.log("default family", getDefaultAutoSelectFamily());

// The server's connection event and the client's connect callback are two
// readiness events on one loop, and which runs first is not something a
// program can rely on: Node and this runtime order them differently on
// macOS. The client's checks wait for the accept instead, so the lines print
// in one order on every platform.
let accepted: (() => void) | null = null;
const acceptedOnce = new Promise<void>((resolve) => {
  accepted = resolve;
});

const server = net.createServer((socket) => {
  socket.on("error", () => {});
  const raw: any = socket;
  console.log("accepted server", raw.server === server);
  console.log("accepted bufferSize", raw.bufferSize);
  console.log("accepted tos", raw.getTypeOfService());
  socket.end("bye");
  accepted?.();
  accepted = null;
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const client = net.connect(port, "127.0.0.1", () => {
    void acceptedOnce.then(() => {
      const raw: any = client;
      console.log("connected bufferSize", raw.bufferSize);
      console.log("attempted", raw.autoSelectFamilyAttemptedAddresses);
      console.log("client server", raw.server);
      console.log("tos", raw.getTypeOfService());
      console.log("tos chain", raw.setTypeOfService(46) === client);
      console.log("tos", raw.getTypeOfService());
      for (const bad of [300, -1, 1.5, NaN, "x"]) {
        try {
          raw.setTypeOfService(bad);
        } catch (error: any) {
          console.log("tos error", error.name, error.code, error.message);
        }
      }
      raw.setTypeOfService(0);
      console.log("tos", raw.getTypeOfService());
      console.log("keepalive bag", raw.setKeepAlive({ enable: true, initialDelay: 1000, interval: 1, count: 2 }) === client);
      console.log("keepalive args", raw.setKeepAlive(true, 500) === client);
      console.log("keepalive off", raw.setKeepAlive(false) === client);
      raw.destroy();
    });
  });
  client.on("error", () => {});
  client.on("close", () => server.close(() => console.log("closed")));
});
