// http.setGlobalProxyFromEnv with no proxy variables: the module is
// configured, and requests still go straight to the target.
import * as http from "node:http";

http.setGlobalProxyFromEnv({});
const server = http.createServer((req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  http.get({ host: "127.0.0.1", port, path: "/direct" }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      console.log("body", body);
      server.close();
    });
  });
});
