// Node treats a present-but-undefined encoding or callback as absent, but it
// still evaluates the argument: an undefined-returning expression runs for
// its side effects before the call. Each shape below compiles, the checks
// print in argument order, and the callbacks follow at the write flush.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

function note(label: string): undefined {
  console.log("note", label);
  return undefined;
}

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
  request.write("a", note("encoding"), () => console.log("first callback"));
  request.write("b", "utf8", note("callback"));
  request.write("c", note("only encoding"));
  request.end("d", note("end"), () => console.log("end callback"));
});
