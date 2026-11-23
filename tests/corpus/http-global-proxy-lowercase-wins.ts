// Both spellings of a proxy variable: Node's lowercase value wins.
import * as http from "node:http";
import * as net from "node:net";

const serve = (body: string, next: (srv: net.Server) => void): void => {
  const srv = net.createServer((socket) => {
    socket.on("data", () => {
      socket.end(
        `HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
  });
  srv.listen(0, "127.0.0.1", () => next(srv));
};

serve("upper", (upper) => {
  serve("lower", (lower) => {
    const upperPort = (upper.address() as { port: number }).port;
    const lowerPort = (lower.address() as { port: number }).port;
    http.setGlobalProxyFromEnv({
      HTTP_PROXY: `http://127.0.0.1:${upperPort}`,
      http_proxy: `http://127.0.0.1:${lowerPort}`,
    });
    http.get("http://target.invalid/x", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        console.log("served by", body);
        upper.close();
        lower.close();
      });
    });
  });
});
