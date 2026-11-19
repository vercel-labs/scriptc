// The dynamic-lane header name readers answer boxed strings: they serialize
// like any other array of strings.
import { createServer, request } from "node:http";

const server = createServer((req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const req = request({ host: "127.0.0.1", port, path: "/", agent: false });
  const untyped = /** @type {any} */ (req);
  req.setHeader("x-one", "1");
  req.setHeader("X-Two", "2");
  const names = untyped.getHeaderNames();
  const raw = untyped.getRawHeaderNames();
  console.log("names", JSON.stringify(names), Array.isArray(names), names.length);
  console.log("raw", JSON.stringify(raw), raw.includes("Host"));
  console.log("joined", names.join("|"), raw.join("|"));
  req.end();
  req.on("response", (res) => res.resume());
  req.on("close", () => server.close(() => console.log("closed")));
});
