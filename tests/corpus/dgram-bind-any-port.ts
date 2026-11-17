// bind(port, address) whose port is typed `any`: the runtime ladder reads
// the number as the port and the string as the address.
import * as dgram from "node:dgram";

const socket = dgram.createSocket("udp4");
const port: any = 0;
await new Promise<void>((resolve) => {
  socket.bind(port, "127.0.0.1", () => {
    const bound = socket.address();
    console.log("bound", bound.address, bound.family, bound.port > 0);
    socket.close(() => resolve());
  });
});
