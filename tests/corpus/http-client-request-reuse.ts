// req.reusedSocket across two requests that share a keep-alive agent socket,
// the request's destroyed flag at the response's 'end' on both the keep-alive
// and the one-shot path, and the response's detached socket when the
// connection returns to the agent.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  const run = (label: string, options: { agent: http.Agent | false }) =>
    new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/", ...options }, (res) => {
        res.resume();
        res.on("end", () => {
          console.log(
            label,
            "reused",
            req.reusedSocket,
            "destroyed",
            req.destroyed,
            "finished",
            req.finished,
            "detachedSocket",
            (res as unknown as { socket: unknown }).socket === null,
          );
          req.on("close", () => {
            console.log(label, "close", req.destroyed);
            resolve();
          });
        });
      });
      req.end();
    });

  void (async () => {
    await run("keep-alive first", { agent });
    await run("keep-alive second", { agent });
    await run("one-shot", { agent: false });
    agent.destroy();
    server.close(() => console.log("closed"));
  })();
});
