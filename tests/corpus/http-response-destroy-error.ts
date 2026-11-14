// res.destroy(err): the error rides the connection's destroy to the
// server's 'clientError' (Node's socketOnError), the response's 'close'
// follows, and the client sees ECONNRESET. A repeat destroy is a no-op,
// destroy(undefined) is destroy(), destroy() alone reports no clientError,
// and a destroy after the head went out still carries the error. The
// server keeps serving after every one of them.
import * as http from "node:http";
import { Socket } from "node:net";

let served = 0;
let port = 0;

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  served++;
  const path = req.url;
  res.on("error", (err) => console.log(path, "res error", err.message));
  res.on("close", () => console.log(path, "res close", res.destroyed));
  if (path === "/plain") {
    res.destroy(new Error("boom"));
    console.log(path, "sync", res.destroyed);
    res.destroy(new Error("again"));
    res.destroy(undefined);
    res.destroy();
    return;
  }
  if (path === "/headed") {
    res.writeHead(200, { connection: "close" });
    res.destroy(new Error("after-head"));
    return;
  }
  if (path === "/coded") {
    const err = new Error("coded") as NodeJS.ErrnoException;
    err.code = "ECUSTOM";
    res.destroy(err);
    return;
  }
  if (path === "/no-error") {
    res.destroy();
    return;
  }
  res.end("ok");
});

server.on("clientError", (err: Error, socket: Socket) => {
  console.log("clientError", err.message, (err as NodeJS.ErrnoException).code, err instanceof Error);
  socket.destroy();
});

function get(path: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      console.log(path, "response", res.statusCode);
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", (err) => {
      console.log(path, "client error", (err as NodeJS.ErrnoException).code, err.message);
      resolve();
    });
    req.on("close", () => resolve());
  });
}

server.listen(0, "127.0.0.1", async () => {
  port = (server.address() as { port: number }).port;
  await get("/plain");
  await get("/headed");
  await get("/coded");
  await get("/no-error");
  await get("/ok");
  console.log("served", served);
  server.close(() => console.log("closed"));
});
