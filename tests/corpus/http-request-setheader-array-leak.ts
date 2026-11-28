// Many typed header arrays through setHeader: each element's text must not be
// retained past the request (LSan repro for the typed-array entry).
import * as http from "node:http";

const server = http.createServer((req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  let done = 0;
  const total = 200;
  for (let i = 0; i < total; i += 1) {
    const values: string[] = ["value-" + i + "-a", "value-" + i + "-b", "value-" + i + "-c"];
    const request = http.request({ port, host: "127.0.0.1" });
    request.setHeader("x-array", values);
    request.on("response", (res) => {
      res.resume();
      res.on("end", () => {
        done += 1;
        if (done === total) {
          console.log("done", done);
          server.close();
        }
      });
    });
    request.on("error", () => {});
    request.end();
  }
});
