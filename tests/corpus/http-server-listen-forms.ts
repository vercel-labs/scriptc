// server.listen() and server.listen(callback) bind an arbitrary unused port,
// as Node's normalizeArgs takes a function first argument as the callback.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const first = http.createServer((req, res) => res.end("first"));
first.listen(() => {
  const port = (first.address() as AddressInfo).port;
  console.log("callback form port > 0", port > 0);
  http.get({ host: "127.0.0.1", port }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => console.log("body", chunk));
    res.on("end", () => {
      first.close();
      const second = http.createServer((req2, res2) => res2.end("second"));
      second.on("listening", () => {
        const port2 = (second.address() as AddressInfo).port;
        console.log("no-argument form port > 0", port2 > 0, port2 !== port);
        second.close();
      });
      second.listen();
    });
  });
});
