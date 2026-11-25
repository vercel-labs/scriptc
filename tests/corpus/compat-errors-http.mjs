// The HTTP error codes of Node's errors chapter that a server and a
// client meet: a response that cannot be piped, trailers with a
// Content-Length, a header written after the head was sent, an invalid
// status code, a socket whose encoding the parser owns, and the parse
// errors of a malformed response. Each case prints the class, name, code
// and message.
import http from "node:http";
import net from "node:net";

const kind = (e) => (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof Error ? "Error" : typeof e);
const show = (label, e) => console.log(label, [kind(e), e.name, e.code, e.message].join(" | "));
function shape(label, fn) {
  try {
    fn();
    console.log(label, "no throw");
  } catch (e) {
    show(label, e);
  }
}

// One request per case: the handler runs the case and answers.
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      handler(request, response);
      if (!response.writableEnded) response.end("done");
    });
    server.listen(0, "127.0.0.1", () => {
      http.get({ host: "127.0.0.1", port: server.address().port }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          console.log("status", response.statusCode, JSON.stringify(body));
          server.close(resolve);
        });
      });
    });
  });
}

await serve((request, response) => {
  shape("response.pipe", () => response.pipe(process.stdout));
});
await serve((request, response) => {
  shape("trailer with length", () => response.writeHead(200, { "Content-Length": "4", Trailer: "X-Checksum" }));
  response.removeHeader("Trailer");
});
await serve((request, response) => {
  response.writeHead(200);
  shape("header after head", () => response.setHeader("X-Late", "1"));
  shape("writeHead twice", () => response.writeHead(204));
});
await serve((request, response) => {
  shape("status code", () => response.writeHead(99));
  shape("header name", () => response.setHeader("bad name", "1"));
  shape("header value", () => response.setHeader("X-Bad", "a\nb"));
  shape("header undefined", () => response.setHeader("X-None", undefined));
});
await serve((request, response) => {
  shape("socket encoding", () => request.socket.setEncoding("utf8"));
});
// A request the client refuses to build.
shape("request path", () => http.request({ host: "127.0.0.1", port: 1, path: "/a b" }));
shape("request method", () => http.request({ host: "127.0.0.1", port: 1, method: "BAD METHOD" }));
shape("request protocol", () => http.request("ftp://127.0.0.1/"));

// Responses the client's parser rejects: the request's 'error' carries
// the parser's code.
function reply(label, text) {
  return new Promise((resolve) => {
    const server = net.createServer((connection) => {
      connection.on("error", () => {});
      connection.on("data", () => connection.end(text));
    });
    server.listen(0, "127.0.0.1", () => {
      const request = http.get({ host: "127.0.0.1", port: server.address().port }, (response) => {
        console.log(label, "response", response.statusCode);
        response.resume();
        response.on("end", () => server.close(resolve));
      });
      request.on("error", (e) => {
        show(label, e);
        server.close(resolve);
      });
    });
  });
}
await reply("length and chunked", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
await reply("not http", "garbage\r\n\r\n");
await reply("header overflow", "HTTP/1.1 200 OK\r\nX-Big: " + "a".repeat(20000) + "\r\nContent-Length: 0\r\n\r\n");
