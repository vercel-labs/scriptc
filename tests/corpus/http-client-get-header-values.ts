// ClientRequest.getHeader answers the value as it was set, as Node does: a
// string, the number given to setHeader, an array value (one element, several,
// none), and undefined once the header is gone.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => res.end("ok"));

function show(label: string, value: unknown): void {
  const text = Array.isArray(value)
    ? `array:${value.length}:${value.join(",")}`
    : `${typeof value}:${String(value)}`;
  console.log(label, text);
}

server.listen(0, "127.0.0.1", () => {
  const request = http.request(
    {
      port: (server.address() as AddressInfo).port,
      host: "127.0.0.1",
      headers: { "x-s": "v", "x-a": ["a"], "x-ab": ["a", "b"], "x-e": [] },
    },
    (res) => {
      res.resume();
      res.on("end", () => server.close());
    },
  );
  show("options string", request.getHeader("x-s"));
  show("options array one", request.getHeader("x-a"));
  show("options array many", request.getHeader("x-ab"));
  show("options array empty", request.getHeader("x-e"));
  show("options missing", request.getHeader("x-missing"));
  request.setHeader("x-h", 7);
  show("set number", request.getHeader("x-h"));
  request.setHeader("x-t", ["t1", "t2"]);
  show("set array", request.getHeader("x-t"));
  request.removeHeader("x-s");
  show("removed", request.getHeader("x-s"));
  request.end();
});
