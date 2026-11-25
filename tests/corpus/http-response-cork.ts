// cork()/uncork()/flushHeaders() on a ServerResponse: the writableCorked
// count, headersSent across the cork, the head and body the client sees
// after each release, and the response's state properties at the same
// points.
import * as http from "node:http";

const server = http.createServer((_req, res) => {
  const state = (label: string): void => {
    console.log(
      label,
      "corked",
      res.writableCorked,
      "headersSent",
      res.headersSent,
      "writableEnded",
      res.writableEnded,
      "writableFinished",
      res.writableFinished,
      "writableLength>0",
      res.writableLength > 0,
    );
  };
  state("handler");
  res.cork();
  res.cork();
  state("corked twice");
  res.write("first ");
  state("after write");
  res.flushHeaders();
  state("flushed");
  res.uncork();
  state("uncorked once");
  res.uncork();
  state("uncorked twice");
  res.end("second");
  state("ended");
  res.on("finish", () => state("finish"));
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  http
    .get({ host: "127.0.0.1", port, path: "/" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        console.log("body", Buffer.concat(chunks).toString());
        server.close(() => console.log("closed"));
      });
    })
    .on("error", (err) => console.log("error", err.message));
});
