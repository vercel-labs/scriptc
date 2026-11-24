// NO_PROXY bypasses the module's proxy, and an explicit agent never uses it:
// both requests go straight to the target, so the proxy stays untouched.
import * as http from "node:http";
import * as net from "node:net";

let proxyHits = 0;
const proxy = net.createServer((socket) => {
  proxyHits++;
  socket.end("HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nproxy");
});
const server = http.createServer((req, res) => res.end("direct"));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  proxy.listen(0, "127.0.0.1", () => {
    const proxyPort = (proxy.address() as { port: number }).port;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    http.setGlobalProxyFromEnv({ HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" });
    http.get(`http://127.0.0.1:${port}/no-proxy`, (first) => {
      let a = "";
      first.setEncoding("utf8");
      first.on("data", (chunk) => {
        a += chunk;
      });
      first.on("end", () => {
        // the proxy now covers the origin, but an explicit agent does not use it
        http.setGlobalProxyFromEnv({ HTTP_PROXY: proxyUrl });
        http
          .get(`http://127.0.0.1:${port}/agent`, { agent: new http.Agent() }, (second) => {
            let b = "";
            second.setEncoding("utf8");
            second.on("data", (chunk) => {
              b += chunk;
            });
            second.on("end", () => {
              console.log("no-proxy", a, "agent", b, "proxy hits", proxyHits);
              proxy.close();
              server.close();
            });
          })
          .on("error", (e) => console.log("error", (e as NodeJS.ErrnoException).code));
      });
    });
  });
});
