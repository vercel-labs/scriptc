// An empty encoding name means the default (utf8) on write and end: Node's
// write_ only validates a truthy encoding, and Buffer.from reads '' as
// utf8, so neither call throws and both chunks arrive as their utf8 bytes.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  console.log("write empty", res.write("x", ""));
  console.log("write spelled", res.write("y", "utf8"));
  res.end("z", "");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (part: string) => (text += part));
    res.on("end", () => {
      console.log("body", JSON.stringify(text));
      server.close(() => console.log("closed"));
    });
  });
  req.on("error", (err: Error) => console.log("error", err.message));
});
