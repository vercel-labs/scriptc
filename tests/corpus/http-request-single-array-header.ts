// A one-element array header stays an ARRAY for the request's own record
// (getHeaders answers the array), though the wire has one line — Node keeps
// the value as set.
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
      headers: { "x-one": ["only"], "x-multi": ["a", "b"] },
    },
    (res) => {
      res.resume();
      res.on("end", () => server.close());
    },
  );
  const show = (value: string | string[] | number | undefined): string =>
    value === undefined
      ? "none"
      : Array.isArray(value)
        ? "array:" + value.join(",")
        : "scalar:" + String(value);
  const headers = request.getHeaders();
  console.log("getHeaders", show(headers["x-one"]), show(headers["x-multi"]));
  request.end();
});
