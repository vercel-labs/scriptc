// An empty or undefined lowercase proxy variable does not mask the uppercase
// fallback: Node still uses the uppercase proxy, or its bypass list.
import * as http from "node:http";
import * as net from "node:net";

const proxy = net.createServer((socket) => {
  socket.on("data", () => {
    socket.end("HTTP/1.1 200 OK\r\ncontent-length: 1\r\nconnection: close\r\n\r\nA");
  });
});
const get = (url: string): Promise<string> =>
  new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(`proxy ${body}`));
    });
    req.on("error", (e) => resolve(`direct ${(e as NodeJS.ErrnoException).code}`));
  });
proxy.listen(0, "127.0.0.1", async () => {
  const port = (proxy.address() as { port: number }).port;
  const spec = `http://127.0.0.1:${port}`;
  http.setGlobalProxyFromEnv({ HTTP_PROXY: spec, http_proxy: "" });
  console.log("empty-lower", await get("http://target.invalid/x"));
  http.setGlobalProxyFromEnv({ HTTP_PROXY: spec, http_proxy: undefined });
  console.log("undefined-lower", await get("http://target.invalid/x"));
  http.setGlobalProxyFromEnv({ HTTP_PROXY: spec, NO_PROXY: "target.invalid", no_proxy: "" });
  console.log("empty-no-proxy", await get("http://target.invalid/x"));
  proxy.close();
});
