// The order of node:http2 server events. A server's 'session' comes before
// a 'connection' listener added later and before the first 'stream'; on a
// TLS server it follows 'connection'. The compatibility 'request' event is
// raised by a 'stream' listener the server adds with the first 'request'
// listener, so it runs among the program's 'stream' listeners in
// registration order. On the compatibility pair, the request's 'close'
// precedes the response's, the response's 'finish' precedes its 'close',
// and the stream's own 'close' listener, added by the handler, runs last.
// A stream reset with an error code emits its 'error' before the pair
// closes, and a destroyed session closes after its streams.
import http2 from "node:http2";
import fs from "node:fs";

function roundTrip(server, client, lines, done) {
  const request = client.request({ ":path": "/a" });
  request.resume();
  request.on("end", () =>
    client.close(() =>
      server.close(() => {
        console.log(lines.join(" | "));
        done(undefined);
      }),
    ),
  );
  request.end();
}

// createServer(handler): the 'request' listener comes first.
await new Promise((resolve) => {
  const lines = [];
  const server = http2.createServer((request, response) => {
    lines.push(`request ${request.url}`);
    response.end("x");
  });
  server.on("stream", (_stream, headers) => lines.push(`stream ${headers[":path"]}`));
  server.on("session", (session) => {
    lines.push("session");
    session.on("stream", () => lines.push("session stream"));
  });
  server.on("connection", (socket) => lines.push(`connection ${typeof socket.remotePort}`));
  server.listen(0, "127.0.0.1", () => roundTrip(server, http2.connect(`http://127.0.0.1:${server.address().port}`), lines, resolve));
});

// A 'stream' listener added before the first 'request' listener.
await new Promise((resolve) => {
  const lines = [];
  const server = http2.createServer();
  server.on("stream", () => lines.push("stream 1"));
  server.on("request", (_request, response) => {
    lines.push("request 1");
    response.end("x");
  });
  server.on("stream", () => lines.push("stream 2"));
  server.on("request", () => lines.push("request 2"));
  server.listen(0, "127.0.0.1", () => roundTrip(server, http2.connect(`http://127.0.0.1:${server.address().port}`), lines, resolve));
});

// TLS: 'connection', then 'session', then the request.
await new Promise((resolve) => {
  const lines = [];
  const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");
  const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
  const ca = fs.readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");
  const server = http2.createSecureServer({ key, cert }, (request, response) => {
    lines.push(`request ${request.url}`);
    response.end("secure");
  });
  server.on("session", () => lines.push("session"));
  server.on("connection", () => lines.push("connection"));
  server.on("stream", (_stream, headers) => lines.push(`stream ${headers[":scheme"]}`));
  server.listen(0, () => roundTrip(server, http2.connect(`https://localhost:${server.address().port}`, { ca }), lines, resolve));
});

// The compatibility pair: 'finish' before 'close' on the response.
await new Promise((resolve) => {
  const lines = [];
  const server = http2.createServer((request, response) => {
    response.on("finish", () => lines.push(`response finish ${response.writableEnded}`));
    response.on("close", () => lines.push("response close"));
    request.stream.on("close", () => lines.push("stream close"));
    request.resume();
    response.end("x");
    lines.push(`after end ${response.writableEnded} ${response.headersSent}`);
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    const request = client.request({ ":path": "/a" });
    request.resume();
    request.on("end", () => setTimeout(() => client.close(() => server.close(() => { console.log(lines.join(" | ")); resolve(undefined); })), 50));
    request.end();
  });
});

// The compatibility pair: the request closes before the response.
await new Promise((resolve) => {
  const lines = [];
  const server = http2.createServer((request, response) => {
    request.on("end", () => lines.push("request end"));
    request.on("close", () => lines.push("request close"));
    response.on("close", () => lines.push("response close"));
    request.stream.on("close", () => lines.push("stream close"));
    request.resume();
    response.end("x");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    const request = client.request({ ":path": "/a" });
    request.resume();
    request.on("end", () => setTimeout(() => client.close(() => server.close(() => { console.log(lines.join(" | ")); resolve(undefined); })), 50));
    request.end();
  });
});

// A reset with an error code: the stream's 'error' comes before the
// pair's 'close' events.
await new Promise((resolve) => {
  const lines = [];
  let client;
  const server = http2.createServer((request, response) => {
    request.on("aborted", () => lines.push("request aborted"));
    request.on("close", () => lines.push("request close"));
    response.on("close", () => {
      lines.push("response close");
      setTimeout(() => client.close(() => server.close(() => { console.log(lines.join(" | ")); resolve(undefined); })), 30);
    });
    request.stream.on("error", (error) => lines.push(`stream error ${error.message}`));
    request.stream.on("close", () => lines.push("stream close"));
    request.resume();
    response.writeHead(200);
    response.write("part");
  });
  server.listen(0, "127.0.0.1", () => {
    client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    const request = client.request({ ":path": "/a" });
    request.on("error", () => {});
    request.on("data", () => request.close(http2.constants.NGHTTP2_INTERNAL_ERROR));
  });
});

// A session destroyed with a request in flight: the pair and the stream
// close before the session does.
await new Promise((resolve) => {
  const lines = [];
  let serverSession;
  const server = http2.createServer((request, response) => {
    request.on("close", () => lines.push("request close"));
    response.on("close", () => lines.push("response close"));
    request.stream.on("close", () => lines.push("stream close"));
    request.resume();
    response.writeHead(200);
    response.write("part");
    setTimeout(() => serverSession.destroy(), 30);
  });
  server.on("session", (session) => {
    serverSession = session;
    session.on("close", () => {
      lines.push("session close");
      setTimeout(() => server.close(() => { console.log(lines.join(" | ")); resolve(undefined); }), 30);
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    client.on("error", () => {});
    const request = client.request({ ":path": "/a" });
    request.on("error", () => {});
    request.resume();
  });
});
