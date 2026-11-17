// The outgoing-message controls on a client request: cork() nesting and the
// writableCorked count, the head an implicit flush holds back until
// flushHeaders(), the uncork flush that releases it, and the body the server
// receives. The state properties are read at every step.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    res.end("got " + Buffer.concat(chunks).toString() + " " + req.headers["content-length"]);
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request(
    { host: "127.0.0.1", port, path: "/", method: "POST", agent: false },
    (res) => {
      res.resume();
      res.on("end", () => {
        console.log("response", res.statusCode);
        req.on("close", () => server.close(() => console.log("closed")));
      });
    },
  );
  const state = (label: string): void => {
    console.log(
      label,
      "corked",
      req.writableCorked,
      "headersSent",
      req.headersSent,
      "writableEnded",
      req.writableEnded,
      "writableFinished",
      req.writableFinished,
      "writableLength>0",
      req.writableLength > 0,
    );
  };
  req.on("finish", () => state("finish"));
  state("created");
  req.cork();
  req.cork();
  state("corked twice");
  req.write("hello ");
  req.write("world");
  state("wrote body");
  req.flushHeaders();
  state("flushed headers");
  req.uncork();
  state("uncorked once");
  req.uncork();
  state("uncorked twice");
  req.end();
  state("ended");
});
