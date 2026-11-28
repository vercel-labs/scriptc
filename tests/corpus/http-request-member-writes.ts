// IncomingMessage's method, url and headers are own data properties (util/dev/server.ts
// builds a request this way): an assignment replaces what later reads answer, a
// per-name write lands in the headers object itself, and rawHeaders and
// headersDistinct keep the parsed lines.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  const parsed = [req.method, req.url];
  // The object the parser built, mutated in place: an existing name keeps its
  // position and a new one appends.
  req.headers["x-a"] = "9";
  req.headers["x-seeded"] = "s";
  const mutated = [
    req.headers["x-a"],
    req.headers["x-seeded"],
    req.rawHeaders.length,
    req.headersDistinct["x-a"]?.join(",") ?? "none",
  ];
  // An assignment replaces the object; per-name writes then land in it.
  req.method = "PATCH";
  req.url = "/rewritten";
  req.headers = { host: "h" };
  req.headers["x-forwarded-for"] = "1.2.3.4";
  const after = [
    req.method,
    req.url,
    req.headers["host"],
    req.headers["x-forwarded-for"],
    req.headers["x-a"] === undefined,
  ];
  res.end(JSON.stringify({ parsed, mutated, after }));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  http.get({ host: "127.0.0.1", port, path: "/orig", headers: { "x-a": "1" } }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      body += chunk;
    });
    res.on("end", () => {
      console.log(body);
      server.close();
    });
  });
});
