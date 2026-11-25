// http.request sends the method upper-cased, as Node's ClientRequest does,
// so a lower-case method from a variable reaches the server as a valid
// request and ClientRequest.method reads the upper-case form.
import * as http from "node:http";
import * as net from "node:net";

const cases: { method: string; path: string }[] = [
  { method: "get", path: "/lower" },
  { method: "Post", path: "/mixed" },
  { method: "PUT", path: "/upper" },
];

const server = http.createServer((req, res) => {
  console.log("server", req.method, req.url);
  req.resume();
  req.on("end", () => res.end("ok"));
});

function next(port: number, i: number): void {
  if (i === cases.length) {
    server.close(() => console.log("closed"));
    return;
  }
  const c = cases[i]!;
  const req = http.request({ host: "127.0.0.1", port, method: c.method, path: c.path }, (res) => {
    console.log("status", res.statusCode);
    res.resume();
    res.on("end", () => next(port, i + 1));
  });
  console.log("client", req.method, req.path);
  req.end();
}

server.listen(0, "127.0.0.1", () => next((server.address() as net.AddressInfo).port, 0));
