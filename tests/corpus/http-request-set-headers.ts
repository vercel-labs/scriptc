// ClientRequest.setHeaders(headers): a Map (or Headers object) of names to
// values, each set through setHeader — appendHeader's earlier values keep
// their several lines, and the call answers the request.
import * as http from "node:http";

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
  const port = (server.address() as { port: number }).port;
  const request = http.request({ port, host: "127.0.0.1" });
  request.appendHeader("x-a", "1");
  request.appendHeader("x-a", "2");
  const same = request.setHeaders(new Headers({ "x-b": "b1", "x-c": "c1" }));
  console.log("answers the request", same === request);
  request.on("response", (res) => {
    res.resume();
    res.on("end", () => server.close());
  });
  request.end();
});
