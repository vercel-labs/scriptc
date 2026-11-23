// An https target through the module's proxy: the CONNECT head Node sends,
// and the ERR_PROXY_TUNNEL refusal when the proxy turns it down.
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";

let captured = "";
const proxy = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    captured += chunk.toString("utf8");
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n");
  });
});
proxy.listen(0, "127.0.0.1", () => {
  const port = (proxy.address() as { port: number }).port;
  http.setGlobalProxyFromEnv({ HTTPS_PROXY: `http://127.0.0.1:${port}` });
  https
    .get("https://target.invalid/x", () => {
      console.log("unexpected response");
    })
    .on("error", (e) => {
      const err = e as NodeJS.ErrnoException;
      console.log("code", err.code);
      console.log(
        "prefix",
        err.message.startsWith("Failed to establish tunnel to target.invalid:443 via http://127.0.0.1:"),
      );
      console.log("status", err.message.endsWith("HTTP/1.1 407 Proxy Authentication Required"));
      console.log(captured.trimEnd().replace(/\r\n/g, " | "));
      proxy.close();
    });
});
