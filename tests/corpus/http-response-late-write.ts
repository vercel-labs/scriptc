// A producer that awaits between chunks and writes after the client went
// away still gets its write callback answered, so the callback cannot keep
// the settled response alive.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";

const server = createServer(async (_req, res) => {
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  res.write("late", () => console.log("late write callback"));
  res.end();
});

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as AddressInfo).port;
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.on("connect", () => {
        socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
        setTimeout(() => socket.destroy(), 10);
      });
      socket.on("error", () => {});
      socket.on("close", () => setTimeout(resolve, 80));
    });
  }
  server.close(() => console.log("closed"));
});
