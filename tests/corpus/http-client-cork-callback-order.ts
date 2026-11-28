// A write made while the message is corked completes with the cork flush:
// its callback must not run when an earlier, already-written chunk drains,
// even though that drain happens while the new chunk still sits in the cork
// buffer. Node corks the message for each write, so both callbacks here
// follow the uncork.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => res.end("ok"));
});

server.listen(0, "127.0.0.1", () => {
  const request = http.request(
    { port: (server.address() as AddressInfo).port, host: "127.0.0.1", method: "POST" },
    (response) => {
      response.resume();
      response.on("end", () => server.close());
    },
  );
  request.on("error", () => {});
  request.write("a", () => console.log("earlier callback"));
  request.cork();
  request.write("b", () => console.log("corked callback"));
  console.log("corked");
  setTimeout(() => {
    console.log("uncork");
    request.uncork();
  }, 50);
  setTimeout(() => request.end(), 100);
});
