// node:http2 in a JavaScript source, over cleartext on loopback: a client
// session's 'connect', 'close' and 'error' events, its type and socket,
// close() with a callback, the server session's 'stream' event, a
// stream's session, and through the compatibility API the request's
// complete flag and 'close' event, and the response's getHeaderNames(),
// getHeaders() and setTimeout(). Every request here completes: the
// request's aborted flag and 'aborted' event are not exercised.
import http2 from "node:http2";

// Core API: session events and state.
await new Promise((resolve) => {
  const lines = [];
  const server = http2.createServer();
  server.on("session", (session) => {
    lines.push(`server type ${session.type === http2.constants.NGHTTP2_SESSION_SERVER}`);
    session.on("stream", (_stream, headers, flags) => lines.push(`session stream ${headers[":path"]} ${typeof flags}`));
  });
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    client.on("connect", (session, socket) => {
      lines.push(`client connect ${session === client} ${typeof socket}`);
      lines.push(`client type ${client.type === http2.constants.NGHTTP2_SESSION_CLIENT}`);
      lines.push(`client socket ${typeof client.socket.remotePort} ${client.socket.remoteAddress}`);
    });
    client.on("close", () => lines.push("client close"));
    const request = client.request({ ":path": "/core" });
    lines.push(`stream session ${request.session === client}`);
    request.resume();
    request.on("end", () =>
      client.close(() => {
        lines.push(`closed ${client.closed} ${client.destroyed}`);
        server.close(() => {
          for (const line of lines.sort()) console.log(line);
          resolve(undefined);
        });
      }),
    );
    request.end();
  });
});

// A session to a closed port reports the connection error and closes.
await new Promise((resolve) => {
  const client = http2.connect("http://127.0.0.1:1");
  client.on("error", (error) => console.log("error", error.code));
  client.on("close", () => {
    console.log("close after error");
    resolve(undefined);
  });
});

// Compatibility API: request flags and events, response header reads.
// The two ends run concurrently, so the lines are sorted.
await new Promise((resolve) => {
  const lines = [];
  const server = http2.createServer((request, response) => {
    request.on("close", () => lines.push("request close"));
    request.resume();
    request.on("end", () => {
      lines.push(`request ${request.complete}`);
      response.setHeader("X-A", "1");
      response.setHeader("x-b", ["2", "3"]);
      lines.push(`headers ${response.getHeaderNames().join(",")} ${JSON.stringify(response.getHeaders())}`);
      response.setTimeout(1000, () => {});
      response.end("done");
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    const request = client.request({ ":path": "/compat" });
    let body = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => lines.push(`status ${headers[":status"]} ${headers["x-a"]}`));
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      lines.push(`body ${body}`);
      client.close(() =>
        server.close(() => {
          for (const line of lines.sort()) console.log(line);
          resolve(undefined);
        }),
      );
    });
    request.end();
  });
});
