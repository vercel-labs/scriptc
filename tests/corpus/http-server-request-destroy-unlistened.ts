// request.destroy(error) on an incomplete server IncomingMessage with no
// 'error' listener: Node's IncomingMessage only emits 'error' when a
// listener exists, so the destroy is reported by 'aborted' and 'close'
// alone and the process does not exit on an unhandled 'error'.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  console.log(path, "handler");
  req.on("aborted", () => console.log(path, "aborted", req.destroyed, req.aborted));
  req.on("close", () => console.log(path, "close", req.destroyed, req.aborted, req.complete));
  if (path === "/early") {
    req.destroy(new Error("boom"));
    console.log(path, "after", req.destroyed, req.aborted);
    return;
  }
  req.resume();
  req.on("end", () => {
    req.destroy(new Error("late"));
    console.log(path, "after end", req.destroyed, req.aborted);
    res.end("late " + path);
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

function hit(path: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (part: string) => (text += part));
      res.on("end", () => console.log(path, "client body", JSON.stringify(text)));
    });
    req.on("error", (err: Error) => console.log(path, "client error", (err as NodeJS.ErrnoException).code));
    req.on("close", () => resolve());
    req.end("payload");
  });
}

await hit("/early");
await hit("/late");
await new Promise<void>((resolve) => server.close(() => resolve()));
console.log("done");
