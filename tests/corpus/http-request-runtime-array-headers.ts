// A request header value computed at run time: Node expands an array into one
// wire line per element, keeps a one-element array an array for getHeader(s),
// and keeps an empty array as an entry with no line at all. A property written
// after the array still lands after its lines.
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
  console.log("server x-empty", Object.prototype.hasOwnProperty.call(req.headers, "x-empty"));
  res.end("ok");
});

function values(): string[] {
  return ["a", "b"];
}

function single(): string[] {
  return ["one"];
}

function none(): string[] {
  return [];
}

server.listen(0, "127.0.0.1", () => {
  const dyn = values();
  const one = single();
  const empty = none();
  const request = http.request(
    {
      port: (server.address() as AddressInfo).port,
      host: "127.0.0.1",
      headers: {
        "x-before": "b",
        "x-dyn": dyn,
        "x-after": "after",
        "x-single": one,
        "x-empty": empty,
        "x-empty-literal": [],
      },
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
  console.log(
    "getHeaders",
    show(headers["x-before"]),
    show(headers["x-dyn"]),
    show(headers["x-single"]),
    show(headers["x-empty"]),
    show(headers["x-empty-literal"]),
  );
  request.end();
});
