// The 'connect' event of a ClientRequest: the response to a CONNECT
// request hands the socket to the listener, whatever its status, with the
// bytes read past the head; the request then closes. Without a listener
// the connection is destroyed. The peers are raw sockets, so the request
// head each one receives is printed too. The typed twin of
// compat-http-client-connect.mjs.
import * as http from "node:http";
import * as net from "node:net";

// 1. A tunnel: a raw peer answers 200 and then echoes, upper-cased, what
// the client writes. The client gets the response, the socket and an
// empty head, talks over the socket, and the request closes.
await new Promise<void>((resolve) => {
  const server = net.createServer((socket) => {
    let text = "";
    let open = false;
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (!open) {
        const end = text.indexOf("\r\n\r\n");
        if (end < 0) return;
        console.log("1 head", JSON.stringify(text.slice(0, end).replace(/Host: 127\.0\.0\.1:\d+/, "Host: H")));
        text = text.slice(end + 4);
        open = true;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      }
      if (text.length > 0) socket.end(text.toUpperCase());
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const request = http.request({ port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", method: "CONNECT", path: "example.test:443", agent: false });
    request.on("response", () => console.log("1 response (never)"));
    request.on("connect", (response, socket, head) => {
      console.log("1 connect", response.statusCode, response.statusMessage, response.httpVersion, head.length);
      let reply = "";
      socket.on("data", (chunk) => {
        reply += chunk.toString();
      });
      socket.on("end", () => {
        console.log("1 tunnel", reply);
        socket.end();
        server.close(() => resolve());
      });
      socket.write("ping");
    });
    request.on("close", () => console.log("1 request close", request.destroyed));
    request.end();
  });
});

// A raw peer for one CONNECT request: prints the request head (the port
// in Host replaced) and answers with `reply`.
function rawPeer(tag: string, reply: string): net.Server {
  return net.createServer((socket) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) return;
      console.log(tag, "head", JSON.stringify(text.slice(0, end).replace(/Host: 127\.0\.0\.1:\d+/, "Host: H")));
      text = "";
      socket.end(reply);
    });
    socket.on("error", () => {});
  });
}

// 2. A status that is not 2xx still arrives through 'connect', and bytes
// in the same segment as the head are the listener's head argument.
await new Promise<void>((resolve) => {
  const server = rawPeer("2", "HTTP/1.1 403 Forbidden\r\nX-Reason: policy\r\n\r\nearly bytes");
  server.listen(0, "127.0.0.1", () => {
    const request = http.request({ port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", method: "CONNECT", path: "blocked.test:80", agent: false });
    request.once("connect", (response, socket, head) => {
      console.log("2 connect", response.statusCode, response.headers["x-reason"], JSON.stringify(head.toString()));
      socket.destroy();
      server.close(() => resolve());
    });
    request.end();
  });
});

// 3. A 1xx status on a CONNECT request is the tunnel's answer too: no
// 'information', no 'continue'.
await new Promise<void>((resolve) => {
  const server = rawPeer("3", "HTTP/1.1 100 Continue\r\n\r\n");
  server.listen(0, "127.0.0.1", () => {
    const request = http.request({ port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", method: "CONNECT", path: "odd.test:80", agent: false });
    request.on("continue", () => console.log("3 continue (never)"));
    request.on("information", () => console.log("3 information (never)"));
    request.on("connect", (response, socket) => {
      console.log("3 connect", response.statusCode);
      socket.destroy();
      server.close(() => resolve());
    });
    request.end();
  });
});

// 4. Without a 'connect' listener the connection is destroyed and the
// request closes.
await new Promise<void>((resolve) => {
  const server = rawPeer("4", "HTTP/1.1 200 Connection Established\r\n\r\n");
  server.listen(0, "127.0.0.1", () => {
    const request = http.request({ port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", method: "CONNECT", path: "unheard.test:80", agent: false });
    request.on("response", () => console.log("4 response (never)"));
    request.on("error", (error: NodeJS.ErrnoException) => console.log("4 error", error.code));
    request.on("close", () => {
      console.log("4 request close");
      server.close(() => resolve());
    });
    request.end();
  });
});
