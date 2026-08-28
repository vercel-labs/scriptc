import * as http2 from "node:http2";

const server = http2.createServer();

server.on("sessionError", () => {
  console.log("session error");
  server.close(() => console.log("server closed"));
});

server.listen(0, () => {
  console.log("listening");
  process.stderr.write(`PORT ${server.address().port}\n`);
});
