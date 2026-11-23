// A relay that forwards headers it built at run time through the module's
// proxy: each outbound request carries a fresh header-name and value string,
// and the proxied target's authority check reads the Host header. The program
// makes many such requests so the sanitized lane's allocation audit sees any
// string the runtime failed to release.
import * as http from "node:http";
import * as net from "node:net";

const proxy = net.createServer((socket) => {
  socket.once("data", () => {
    socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
  });
});

proxy.listen(0, "127.0.0.1", () => {
  const port = proxy.address().port;
  http.setGlobalProxyFromEnv({ HTTP_PROXY: `http://127.0.0.1:${port}` });
  const total = 25;
  let done = 0;
  for (let i = 0; i < total; i++) {
    const headers = {};
    headers.host = "target.invalid";
    headers["x-forwarded-for"] = `10.0.0.${i}`;
    const options = { host: "target.invalid", port: 80, path: "/forward", headers };
    const req = http.request(options, (res) => {
      res.resume();
      res.on("end", () => {
        done += 1;
        if (done === total) {
          console.log("done", done);
          proxy.close();
        }
      });
    });
    req.on("error", (e) => console.log("error", e.code));
    req.end();
  }
});
