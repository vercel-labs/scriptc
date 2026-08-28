import * as http2 from "node:http2";

const server = http2.createServer();

server.on("sessionError", (_error: Error, session: http2.ServerHttp2Session) => {
  console.log("session error");
  session.destroy();
  server.close(() => console.log("server closed"));
});

server.listen(0, () => {
  console.log("listening");
  process.stderr.write(`PORT ${server.address().port}\n`);
});
