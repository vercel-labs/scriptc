import { connect } from "node:net";

const port = Number(process.argv[2]);

await new Promise((resolve, reject) => {
  const socket = connect(port, "127.0.0.1", () => socket.write("x".repeat(24)));
  socket.on("data", () => {});
  socket.on("error", reject);
  socket.on("close", resolve);
});
