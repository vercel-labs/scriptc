// ClientRequest's on(), once() and addListener() answer the request, as in
// Node, so registrations chain: request(...).on(...).on(...).end().
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => res.end(`${req.method} ${req.url}`));

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const req = http
    .request({ host: "127.0.0.1", port, path: "/chained", method: "POST" })
    .on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => console.log("body", chunk));
      res.on("end", () => {
        http
          .get({ host: "127.0.0.1", port, path: "/second" })
          .once("response", (res2) => {
            console.log("second status", res2.statusCode);
            res2.resume();
            res2.on("end", () => server.close());
          })
          .addListener("error", (e) => console.log("error", e.message));
      });
    })
    .on("error", (e) => console.log("error", e.message));
  console.log("chained answers the request", req.method, req.path);
  req.end();
});
