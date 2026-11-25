// http.setGlobalProxyFromEnv with an HTTP_PROXY: a plain-http request goes to
// the proxy carrying the absolute URI, exactly as Node sends it.
import * as http from "node:http";
import * as net from "node:net";

let captured = "";
const proxy = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    captured += chunk.toString("utf8");
    socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
  });
});
proxy.listen(0, "127.0.0.1", () => {
  const port = (proxy.address() as { port: number }).port;
  http.setGlobalProxyFromEnv({ HTTP_PROXY: `http://127.0.0.1:${port}` });
  http
    .get("http://target.invalid/hello?x=1", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        console.log("status", res.statusCode, "body", body);
        console.log(captured.trimEnd().replace(/\r\n/g, " | "));
        proxy.close();
      });
    })
    .on("error", (e) => {
      console.log("error", (e as NodeJS.ErrnoException).code);
      proxy.close();
    });
});
