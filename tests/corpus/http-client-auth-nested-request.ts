import * as http from "node:http";

// The auth option of http.request must reach ITS request even when another
// request is constructed while the options object's expressions evaluate:
// Node builds every option value before the request exists, so a nested
// request constructed by one of them must not take the outer credentials.
const seen: string[] = [];

function nestedRequest(): string {
  const inner = http.request(
    {
      host: "127.0.0.1",
      port: (server.address() as { port: number }).port,
      path: "/inner-plain",
      auth: "inner:secret",
    },
    (res) => res.resume(),
  );
  inner.end();
  return "from-nested";
}

const server = http.createServer((req, res) => {
  seen.push(`${req.url} auth=${req.headers.authorization ?? "none"} v=${req.headers["x-v"] ?? "none"}`);
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const outer = http.request(
    {
      host: "127.0.0.1",
      port: (server.address() as { port: number }).port,
      path: "/outer",
      auth: "user:pass",
      headers: { "x-v": nestedRequest() },
    },
    (res) => {
      res.resume();
      res.on("end", () => {
        server.close(() => {
          for (const line of seen.sort()) console.log(line);
        });
      });
    },
  );
  outer.end();
});
