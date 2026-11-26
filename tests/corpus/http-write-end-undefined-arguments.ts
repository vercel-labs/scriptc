// Node treats a present-but-undefined encoding or callback as absent:
// write(chunk, undefined, cb), write(chunk, encoding, undefined) and
// write(chunk, undefined) are the shorter calls, and end(data, undefined, cb)
// ends with the callback. Each shape compiles and runs identically.
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
  request.write("a", undefined, () => console.log("first callback"));
  request.write("b", "utf8", undefined);
  request.write("c", undefined);
  request.end("d", undefined, () => console.log("end callback"));
});
