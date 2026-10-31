// A malformed request on a kept-alive connection after a response closes
// the connection without a 400, as Node writes its parser-error response
// only when nothing was written on the connection yet. A malformed first
// request is answered with 400.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req, res) => res.end("ok"));

function send(port: number, raw: string, then: () => void): void {
  const sock = net.connect(port, "127.0.0.1", () => sock.write(raw));
  let text = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    text += chunk;
  });
  sock.on("close", () => {
    console.log(JSON.stringify(text.replace(/Date: [^\r]*\r\n/, "")));
    then();
  });
}

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  send(port, "GET / HTTP/1.1\r\nHost: a\r\n\r\nGET / HTTP/1.1\r\nHost : a\r\n\r\n", () =>
    send(port, "GET / HTTP/1.1\r\nHost : a\r\n\r\n", () => server.close()),
  );
});
