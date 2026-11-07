// Two request shapes the HTTP/1 server reads as Node does. A Content-Length
// or Transfer-Encoding field in the trailers of a chunked request is a
// parse error (400, 'clientError' with llhttp's code), and so is
// Content-Length in the trailers of a chunked response. An Upgrade request
// to a server with no 'upgrade' listener is an ordinary request.
import * as http from "node:http";
import { connect, createServer } from "node:net";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d: Buffer) => {
    body += d.toString("latin1");
  });
  req.on("end", () => {
    console.log("  request", req.method, req.url, JSON.stringify(body), JSON.stringify(req.trailers), "upgrade:", String(req.headers["upgrade"]));
    res.end("ok");
  });
});
server.on("clientError", (e: NodeJS.ErrnoException, socket) => {
  console.log("  clientError", e.code, JSON.stringify(e.message));
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

function send(port: number, label: string, payload: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const c = connect(port, "127.0.0.1", () => c.write(payload));
    let seen = "";
    c.on("data", (d: Buffer) => {
      seen += d.toString("latin1");
    });
    c.on("error", () => {});
    c.on("close", () => {
      console.log(label, "=>", JSON.stringify(seen.split("\r\n")[0] ?? ""));
      resolve();
    });
  });
}

function receive(label: string, trailer: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const upstream = createServer((c) => {
      c.on("data", () => {
        c.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n" + trailer + "\r\n\r\n");
      });
      c.on("error", () => {});
    });
    upstream.listen(0, "127.0.0.1", () => {
      const port = (upstream.address() as { port: number }).port;
      const req = http.request({ host: "127.0.0.1", port, agent: false }, (res) => {
        let body = "";
        res.on("data", (d: Buffer) => {
          body += d.toString();
        });
        res.on("end", () => console.log(label, "response end", JSON.stringify(body), JSON.stringify(res.trailers)));
        res.on("error", (e: NodeJS.ErrnoException) => console.log(label, "response error", e.code, JSON.stringify(e.message)));
        res.on("close", () => {
          upstream.close();
          resolve();
        });
      });
      req.on("error", (e: NodeJS.ErrnoException) => console.log(label, "request error", e.code, JSON.stringify(e.message)));
      req.end();
    });
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  const chunked = "Host: x\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n";
  await send(port, "trailer Content-Length", "POST /a HTTP/1.1\r\n" + chunked + "Content-Length: 5\r\n\r\n");
  await send(port, "trailer cOnTeNt-LeNgTh", "POST /b HTTP/1.1\r\n" + chunked + "cOnTeNt-LeNgTh: 0\r\n\r\n");
  await send(port, "trailer Transfer-Encoding: chunked", "POST /c HTTP/1.1\r\n" + chunked + "Transfer-Encoding: chunked\r\n\r\n");
  await send(port, "trailer Transfer-Encoding: gzip", "POST /d HTTP/1.1\r\n" + chunked + "Transfer-Encoding: gzip\r\n\r\n");
  await send(port, "after another trailer", "POST /e HTTP/1.1\r\n" + chunked + "X-T: 1\r\nContent-Length: 5\r\n\r\n");
  await send(port, "trailer Content-Length-Hint", "POST /f HTTP/1.1\r\n" + chunked + "Content-Length-Hint: 5\r\n\r\n");
  await send(port, "plain trailer", "POST /g HTTP/1.1\r\n" + chunked + "X-T: 1\r\n\r\n");
  const upgrade = "Host: x\r\nConnection: Upgrade, close\r\nUpgrade: websocket\r\n";
  await send(port, "upgrade", "GET /h HTTP/1.1\r\n" + upgrade + "\r\n");
  await send(port, "upgrade with a body", "POST /i HTTP/1.1\r\n" + upgrade + "Content-Length: 3\r\n\r\nabc");
  server.close();
  await receive("response trailer Content-Length", "Content-Length: 5");
  await receive("response trailer Transfer-Encoding", "Transfer-Encoding: chunked");
  await receive("response plain trailer", "X-T: 1");
});
