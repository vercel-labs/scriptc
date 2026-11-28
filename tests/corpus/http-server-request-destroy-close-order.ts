// A server request destroyed mid-body reports 'aborted', then the request's
// own 'close', and only then the response's 'close' — Node's order.
import * as http from "node:http";

const order: string[] = [];
const server = http.createServer((req, res) => {
  req.on("close", () => order.push("req close"));
  req.on("aborted", () => order.push("req aborted"));
  req.on("data", () => {});
  req.on("end", () => order.push("req end"));
  setTimeout(() => {
    req.destroy();
    res.on("close", () => {
      order.push("res close");
      console.log(order.join(", "));
      server.close();
    });
  }, 20);
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const request = http.request({ port, host: "127.0.0.1", method: "POST", headers: { "content-length": "10" } });
  request.on("error", () => {});
  request.on("response", (res) => res.resume());
  request.write("12345");
});
