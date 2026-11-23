// NO_PROXY forms against Node's routing: a bare host exempts exactly that
// host, a dot-prefixed suffix exempts the apex and its subdomains, and a
// `*.`-prefixed entry exempts the subdomains only.
import * as http from "node:http";
import * as net from "node:net";

const proxy = net.createServer((socket) => {
  socket.on("data", () => {
    socket.end("HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nproxy");
  });
});

const get = (url: string): Promise<string> =>
  new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on("end", () => resolve("proxy"));
    });
    req.on("error", (e) => resolve(`direct ${(e as NodeJS.ErrnoException).code}`));
  });

proxy.listen(0, "127.0.0.1", async () => {
  const port = (proxy.address() as { port: number }).port;
  const cases: Array<[string, string, string]> = [
    ["bare-sub", "target.invalid", "http://sub.target.invalid/x"],
    ["dotted-apex", ".target.invalid", "http://target.invalid/x"],
    ["dotted-sub", ".target.invalid", "http://sub.target.invalid/x"],
    ["wild-sub", "*.target.invalid", "http://sub.target.invalid/x"],
    ["wild-apex", "*.target.invalid", "http://target.invalid/x"],
    ["star", "*", "http://target.invalid/x"],
  ];
  for (const [label, noProxy, url] of cases) {
    http.setGlobalProxyFromEnv({ HTTP_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: noProxy });
    console.log(label, await get(url));
  }
  proxy.close();
});
