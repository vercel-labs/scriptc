// writeHead(status, undefined, headers) takes the reason phrase as absent
// and sends the headers, as Node does: the status code's default phrase
// with the third argument's headers.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

let round = 0;
const server = http.createServer((req, res) => {
  round++;
  if (round === 1) res.writeHead(200, undefined, ["foo", "bar"]);
  else res.writeHead(201, undefined, { "x-two": "2" });
  res.end();
});

function get(then: () => void): void {
  const port = (server.address() as AddressInfo).port;
  http.get({ host: "127.0.0.1", port }, (res) => {
    console.log(res.statusCode, res.statusMessage, res.headers.foo ?? "-", res.headers["x-two"] ?? "-");
    res.resume();
    res.on("end", then);
  });
}

server.listen(0, "127.0.0.1", () => get(() => get(() => server.close())));
