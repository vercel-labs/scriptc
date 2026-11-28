// setHeaders after the head went out throws ERR_HTTP_HEADERS_SENT, even with
// an empty Map or Headers — Node checks headersSent before it iterates.
import * as http from "node:http";

const server = http.createServer((req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const report = (label: string, fn: () => void): void => {
    try {
      fn();
      console.log(label, "accepted");
    } catch (error) {
      const caught = error as NodeJS.ErrnoException;
      console.log(label, caught.code, caught.message);
    }
  };
  const first = http.request({ port, host: "127.0.0.1" });
  first.flushHeaders();
  report("map", () => first.setHeaders(new Map()));
  report("headers", () => first.setHeaders(new Headers()));
  report("named", () => first.setHeaders(new Map([["x-a", "1"]])));
  first.on("error", () => {});
  first.on("response", (res) => res.resume());
  first.end();
  setTimeout(() => server.close(), 100);
});
