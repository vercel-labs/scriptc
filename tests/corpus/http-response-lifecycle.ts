// ServerResponse lifecycle: the writable watermark and object mode, the
// 'prefinish' and 'finish' events with the finished flag at each, the
// 'close' event, and destroy(error) ending a response partway through.
import * as http from "node:http";

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

const origin = "127.0.0.1";

void (async () => {
  const server = http.createServer((_req, res) => {
    console.log("watermark", res.writableHighWaterMark, res.writableObjectMode);
    console.log("finished before", res.finished);
    res.on("prefinish", () => console.log("prefinish", res.finished));
    res.on("finish", () => console.log("finish", res.finished, res.writableFinished));
    res.on("close", () => console.log("response close", res.finished, res.writableFinished));
    res.write("a");
    res.end("b");
  });
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    http.get({ host: origin, port, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        console.log("client body", Buffer.concat(chunks).toString());
        server.close(() => resolve());
      });
    });
  });

  const destroyed = http.createServer((_req, res) => {
    res.writeHead(200, { "content-length": "100" });
    res.write("short");
    setTimeout(() => {
      console.log("destroying", res.finished, res.destroyed);
      res.destroy();
    }, 20);
  });
  const destroyedPort = await listen(destroyed);
  await new Promise<void>((resolve) => {
    http
      .get({ host: origin, port: destroyedPort, agent: false }, (res) => {
        res.on("data", () => {});
        res.on("error", (err: NodeJS.ErrnoException) => console.log("client error", err.code));
        res.on("close", () => {
          console.log("client close", res.complete);
          destroyed.close(() => resolve());
        });
      })
      .on("error", () => {});
  });
  console.log("done");
})();
