// The response head follows the user's framing headers as Node's does: a
// Keep-Alive header replaces the default keep-alive hint, a Connection: close
// header closes the connection after the response, removeHeader of
// Connection, Content-Length, Transfer-Encoding and Date keeps those headers
// out of the head (both framing headers removed sends the body unframed and
// closes), and a 204 or 304 with a chunked Transfer-Encoding sends no chunk
// terminator and closes.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req, res) => {
  switch (req.url) {
    case "/keep-alive":
      res.setHeader("Keep-Alive", "timeout=1");
      res.end("ka");
      break;
    case "/close":
      res.setHeader("Connection", "close");
      res.end("bye");
      break;
    case "/removed":
      res.removeHeader("connection");
      res.removeHeader("transfer-encoding");
      res.removeHeader("content-length");
      res.removeHeader("date");
      res.setHeader("date", "coffee o clock");
      res.end("beep boop");
      break;
    case "/removed-length":
      res.removeHeader("Date");
      res.removeHeader("Content-Length");
      res.end("chunked instead");
      break;
    case "/204":
      res.writeHead(204, { "Transfer-Encoding": "chunked" });
      res.end();
      break;
    default:
      res.writeHead(304, { "Transfer-Encoding": "chunked" });
      res.end();
  }
});

const paths = ["/keep-alive", "/close", "/removed", "/removed-length", "/204", "/304"];

function exchange(port: number, index: number): void {
  if (index === paths.length) {
    server.close();
    return;
  }
  const path = paths[index]!;
  const conn = net.createConnection(port, "127.0.0.1", () => {
    conn.write(`GET ${path} HTTP/1.1\r\nHost: example.com\r\n\r\n`);
  });
  let text = "";
  conn.setEncoding("utf8");
  conn.on("data", (chunk: string) => {
    text += chunk;
    // a kept-alive connection stays open: end it once the body arrived
    if (path === "/keep-alive" && text.endsWith("\r\n\r\nka")) conn.end();
    if (path === "/removed-length" && text.endsWith("0\r\n\r\n")) conn.end();
  });
  conn.on("end", () => {
    const lines = text.split("\r\n").filter((line) => !line.startsWith("Date: "));
    console.log(path, JSON.stringify(lines.join("|")));
    exchange(port, index + 1);
  });
}

server.listen(0, "127.0.0.1", () => {
  exchange((server.address() as net.AddressInfo).port, 0);
});
