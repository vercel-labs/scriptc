// A proxy URL with credentials and a non-default target port: the request
// carries the absolute URI with the port and a proxy-authorization line.
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
  http.setGlobalProxyFromEnv({ HTTP_PROXY: `http://user:pw@127.0.0.1:${port}` });
  http
    .get("http://target.invalid:8080/secure", (res) => {
      res.resume();
      res.on("end", () => {
        console.log(captured.trimEnd().replace(/\r\n/g, " | "));
        proxy.close();
      });
    })
    .on("error", (e) => {
      console.log("error", (e as NodeJS.ErrnoException).code);
      proxy.close();
    });
});
