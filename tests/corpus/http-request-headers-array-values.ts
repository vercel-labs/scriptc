// Node's array-valued request header: one wire line per element, and a
// cookie array joins with "; ". The server reports the raw header lines.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  const lines: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (name === "Host" || name === "Connection") continue;
    lines.push(name + "=" + req.rawHeaders[i + 1]!);
  }
  console.log("headers", lines.join("|"));
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const request = http.request(
    {
      port: (server.address() as AddressInfo).port,
      host: "127.0.0.1",
      headers: { "x-multi": ["a", "b"], cookie: ["a=1", "b=2"], "x-one": "solo" },
    },
    (res) => {
      res.resume();
      res.on("end", () => server.close());
    },
  );
  request.on("error", (error: NodeJS.ErrnoException) => console.log("error", error.code));
  request.end();
});
