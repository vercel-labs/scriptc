// Percent-encoded proxy credentials: Node decodes them before Basic auth.
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
  http.setGlobalProxyFromEnv({ HTTP_PROXY: `http://us%65r:p%40ss@127.0.0.1:${port}` });
  http
    .get("http://target.invalid/x", (res) => {
      res.resume();
      res.on("end", () => {
        const auth = captured
          .split("\r\n")
          .find((line) => line.toLowerCase().startsWith("proxy-authorization"));
        console.log(auth);
        proxy.close();
      });
    })
    .on("error", (e) => {
      console.log("error", (e as NodeJS.ErrnoException).code);
      proxy.close();
    });
});
