// A response torn down before its pending write drains must release the
// listeners it still holds: a client that aborts a streaming response never
// reaches 'drain' or 'finish', and a listener that captured the response
// would keep it (and everything the closure captured) alive. The sanitized
// lane's refcount audit is the assertion here; the program pins what the
// events do.
import * as http from "node:http";

const CHUNK = 200000;

const server = http.createServer((req, res) => {
  const captured = res;
  captured.once("drain", () => {
    console.log("drain fired", captured.writableLength);
  });
  captured.once("finish", () => {
    console.log("finish fired");
  });
  captured.on("close", () => {
    console.log("close", captured.writableNeedDrain, captured.destroyed, captured.writableFinished);
    server.close();
  });
  const accepted = captured.write("x".repeat(CHUNK));
  console.log("write", accepted, captured.writableNeedDrain);
  captured.destroy();
});

server.listen(0, "127.0.0.1", () => {
  const req = http.get({ host: "127.0.0.1", port: server.address().port, path: "/" }, (res) => {
    res.on("data", () => {});
    res.on("end", () => console.log("client end"));
  });
  req.on("error", (err) => console.log("client error", (err as { code?: string }).code));
});
