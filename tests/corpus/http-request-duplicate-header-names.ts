// A header name given twice in the options record (differing only in case):
// Node sets it once, the later value and spelling winning, so the wire has a
// single line and getHeader(s) answer the last value. Two arrays under such
// names do not merge: the later array replaces the earlier one.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  const lines: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (name === "Host" || name === "Connection") continue;
    lines.push(name + "=" + req.rawHeaders[i + 1]!);
  }
  console.log("server", lines.join("|"));
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const request = http.request(
    {
      port: (server.address() as AddressInfo).port,
      host: "127.0.0.1",
      headers: { "x-a": "1", "X-A": "2", "x-b": "keep", "x-c": ["1"], "X-C": ["2", "3"] },
    },
    (res) => {
      res.resume();
      res.on("end", () => server.close());
    },
  );
  const value = request.getHeader("x-a");
  console.log("getHeader", value, typeof value);
  const dup = request.getHeaders()["x-c"];
  console.log("getHeaders x-c", Array.isArray(dup) ? dup.join(",") : String(dup));
  request.end();
});
