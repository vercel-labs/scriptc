// A write past end() whose message is destroyed before the deferred error
// runs: Node reports it to the write callback only (none here, so nothing is
// emitted), answers false, and the retained request is released either way.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  req.resume();
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  let errors = 0;
  for (let i = 0; i < 12; i++) {
    const req = http.request({ host: "127.0.0.1", port, path: "/", method: "POST" }, (res) => {
      res.resume();
    });
    req.on("error", (e) => {
      errors++;
      console.log("error", (e as NodeJS.ErrnoException).code);
    });
    req.end();
    console.log("late", req.write("late"));
    req.destroy();
  }
  setTimeout(() => {
    console.log("errors", errors);
    server.close();
  }, 100);
});
