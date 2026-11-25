// The server 'connect' event: a CONNECT request fires it INSTEAD of
// 'request' with (req, socket, head) — the request's own socket, the bytes
// read past the head as a Buffer — and the listener owns the tunnel from
// then on (write/echo, 'end', 'close'). Without a listener the server
// closes the connection.
import * as http from "node:http";
import * as net from "node:net";

const tunnel = (label: string): void => {
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    console.log(label, "request", req.url);
    res.end("no");
  });
  server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    console.log(
      label,
      "connect",
      req.method,
      req.url,
      JSON.stringify(req.headers.host ?? null),
      Buffer.isBuffer(head),
      head.length,
      req.socket === socket,
      typeof socket.remoteAddress,
      typeof socket.remotePort,
      socket.readable,
      socket.writable,
      socket.destroyed,
    );
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.on("data", (chunk: Buffer) => {
      console.log(label, "tunnel", JSON.stringify(chunk.toString("utf8")));
      socket.write("echo:" + chunk.toString("utf8"));
    });
    socket.on("end", () => {
      console.log(label, "socket end");
      socket.end();
    });
    socket.on("close", () => console.log(label, "socket close"));
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as net.AddressInfo).port;
    const client = net.connect(port, "127.0.0.1", () => {
      client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    });
    let seen = "";
    client.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (!seen.includes("echo:ping") && seen.includes("\r\n\r\n")) {
        console.log(label, "client 200");
        client.write("ping");
      } else if (seen.includes("echo:ping")) {
        console.log(label, "client echo");
        client.end();
      }
    });
    client.on("close", () => {
      console.log(label, "client close");
      server.close(headBytes);
    });
  });
};

// bytes already read past the CONNECT head arrive as `head`
const headBytes = (): void => {
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    console.log("head request", req.url);
    res.end("no");
  });
  server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    console.log(
      "head connect",
      req.url,
      Buffer.isBuffer(head),
      head.length,
      JSON.stringify(head.toString("utf8")),
    );
    socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as net.AddressInfo).port;
    const client = net.connect(port, "127.0.0.1", () => {
      client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\nEARLY");
    });
    let seen = "";
    client.on("data", (chunk: Buffer) => (seen += chunk.toString("utf8")));
    client.on("close", () => {
      console.log("head client close", JSON.stringify(seen.split("\r\n")[0] ?? ""));
      server.close(noListener);
    });
  });
};

// no 'connect' listener: the server closes the connection, and the request
// handler never runs
const noListener = (): void => {
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    console.log("none request", req.url);
    res.end("no");
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as net.AddressInfo).port;
    const client = net.connect(port, "127.0.0.1", () => {
      client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n");
    });
    let seen = "";
    client.on("data", (chunk: Buffer) => (seen += chunk.toString("utf8")));
    client.on("close", () => {
      console.log("none client close", JSON.stringify(seen));
      server.close();
    });
  });
};

tunnel("tunnel");
