// The 'connect' event of a ClientRequest that is reached through an
// untyped value: a function parameter of a JavaScript source. The
// listener gets the response, the socket and the bytes read past the
// head, as it does on a request the compiler knows the class of;
// 'response' is not emitted, and the request then closes.
import http from "node:http";
import net from "node:net";

// A raw peer for one CONNECT request: prints the request head (the port
// in Host replaced), answers with `reply`, and then echoes, upper-cased,
// what the client writes when `echo` is set.
function rawPeer(tag, reply, echo) {
  return net.createServer((socket) => {
    let text = "";
    let open = false;
    socket.on("data", (chunk) => {
      text += chunk;
      if (!open) {
        const end = text.indexOf("\r\n\r\n");
        if (end < 0) return;
        console.log(tag, "head", JSON.stringify(text.slice(0, end).replace(/Host: 127\.0\.0\.1:\d+/, "Host: H")));
        text = text.slice(end + 4);
        open = true;
        if (!echo) {
          socket.end(reply);
          return;
        }
        socket.write(reply);
      }
      if (text.length > 0) socket.end(text.toUpperCase());
    });
    socket.on("error", () => {});
  });
}

function connectRequest(server, path) {
  return http.request({ port: server.address().port, host: "127.0.0.1", method: "CONNECT", path, agent: false });
}

// The registrations: `request` is whatever the caller passes.
function onConnect(request, listener) {
  return request.on("connect", listener);
}

function onceConnect(request, listener) {
  return request.once("connect", listener);
}

function addConnect(request, listener) {
  return request.addListener("connect", listener);
}

// 1. A tunnel through on(): the listener talks over the socket it is
// handed, 'response' never fires, on() answers the request itself, and
// the request closes.
await new Promise((resolve) => {
  const server = rawPeer("1", "HTTP/1.1 200 Connection Established\r\n\r\n", true);
  server.listen(0, "127.0.0.1", () => {
    const request = connectRequest(server, "example.test:443");
    request.on("response", () => console.log("1 response (never)"));
    const answer = onConnect(request, (response, socket, head) => {
      console.log("1 connect", response.statusCode, response.statusMessage, response.httpVersion, head.length);
      let reply = "";
      socket.on("data", (chunk) => {
        reply += chunk;
      });
      socket.on("end", () => {
        console.log("1 tunnel", reply);
        socket.end();
        server.close(resolve);
      });
      socket.write("ping");
    });
    console.log("1 on() answers the request", answer === request);
    request.on("close", () => console.log("1 request close", request.destroyed));
    request.end();
  });
});

// 2. once(): a status that is not 2xx still arrives through 'connect',
// and bytes in the same segment as the head are the head argument, a
// Buffer.
await new Promise((resolve) => {
  const server = rawPeer("2", "HTTP/1.1 403 Forbidden\r\nX-Reason: policy\r\n\r\nearly bytes", false);
  server.listen(0, "127.0.0.1", () => {
    const request = connectRequest(server, "blocked.test:80");
    onceConnect(request, (response, socket, head) => {
      console.log("2 connect", response.statusCode, response.headers["x-reason"], Buffer.isBuffer(head), JSON.stringify(head.toString()));
      socket.destroy();
      server.close(resolve);
    });
    request.end();
  });
});

// 3. Two listeners, one through addListener() and one registered on the
// request the source knows the class of: both run, in registration order,
// with the same socket.
await new Promise((resolve) => {
  const server = rawPeer("3", "HTTP/1.1 200 OK\r\n\r\n", false);
  server.listen(0, "127.0.0.1", () => {
    const request = connectRequest(server, "twice.test:80");
    let first = null;
    addConnect(request, (response, socket) => {
      console.log("3 first", response.statusCode);
      first = socket;
    });
    request.on("connect", (response, socket) => {
      console.log("3 second", response.statusCode, typeof first, first !== null && first.remotePort === socket.remotePort);
      socket.destroy();
      server.close(resolve);
    });
    request.end();
  });
});

// 4. A listener that is not a function is refused where it is
// registered, and the request still closes without a listener.
await new Promise((resolve) => {
  const server = rawPeer("4", "HTTP/1.1 200 Connection Established\r\n\r\n", false);
  server.listen(0, "127.0.0.1", () => {
    const request = connectRequest(server, "unheard.test:80");
    try {
      onConnect(request, "not a function");
    } catch (error) {
      console.log("4 refused", error.name, error.code);
    }
    request.on("error", (error) => console.log("4 error", error.code));
    request.on("close", () => {
      console.log("4 request close");
      server.close(resolve);
    });
    request.end();
  });
});
