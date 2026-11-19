// IncomingMessage on both sides: statusMessage and the raw header list,
// headers, the connection and socket aliases, the aborted flag, and the
// 'close' event that follows a completed body or a connection torn down
// partway through one.
import * as http from "node:http";

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

const origin = "127.0.0.1";

void (async () => {
  const server = http.createServer((req, res) => {
    console.log(
      "request headers",
      String(req.headers.host).replaceAll(String(port), "PORT"),
      req.headers["content-length"],
    );
    console.log("request rawHeaders", JSON.stringify(req.rawHeaders).replaceAll(String(port), "PORT"));
    console.log("request connection alias", req.connection === req.socket, typeof req.socket.remotePort);
    console.log("request aborted", req.aborted);
    req.on("close", () => console.log("request close", req.aborted));
    req.resume();
    req.on("end", () => {
      res.sendDate = false;
      res.setHeader("x-test", "value");
      res.setHeader("set-cookie", ["a=1", "b=2"]);
      res.setHeader("connection", "close");
      res.end("body");
    });
  });
  const port = await listen(server);

  await new Promise<void>((resolve) => {
    const req = http.request(
      { host: origin, port, method: "POST", headers: { "content-length": "3" }, agent: false },
      (res) => {
        console.log("response statusMessage", res.statusMessage);
        console.log("response headers", res.headers["x-test"], res.headers["content-length"]);
        console.log("response rawHeaders", JSON.stringify(res.rawHeaders));
        console.log("response connection alias", res.connection === res.socket);
        console.log("response aborted", res.aborted);
        res.on("close", () => {
          console.log("response close", res.aborted, res.complete);
          server.close(() => resolve());
        });
        res.resume();
      },
    );
    req.end("abc");
  });

  // A response whose connection ends before its Content-Length is aborted.
  const partial = http.createServer((_req, res) => {
    res.writeHead(200, { "content-length": "100" });
    res.write("short");
    setTimeout(() => res.socket?.destroy(), 20);
  });
  const partialPort = await listen(partial);
  await new Promise<void>((resolve) => {
    http
      .get({ host: origin, port: partialPort, agent: false }, (res) => {
        console.log("partial aborted at start", res.aborted);
        res.on("aborted", () => console.log("partial aborted event", res.aborted));
        res.on("close", () => {
          console.log("partial close", res.aborted, res.complete);
          partial.close(() => resolve());
        });
        res.resume();
      })
      .on("error", () => {});
  });
  console.log("done");
})();
