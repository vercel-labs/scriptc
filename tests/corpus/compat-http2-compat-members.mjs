// Members of node:http2's compatibility request and response, each read
// or called on a request that completes: the request's method, url,
// headers, httpVersion, rawHeaders, socket and setTimeout(); the
// response's statusCode, setHeader(), getHeader(), hasHeader(),
// removeHeader(), writeHead(), write(), end() with a callback, headersSent,
// finished, writableEnded, req and socket. The two ends race, so the lines
// are sorted.
import http2 from "node:http2";

await new Promise((resolve) => {
  const lines = [];
  const server = http2.createServer((request, response) => {
    lines.push(`request ${request.method} ${request.url} ${request.httpVersion} ${request.httpVersionMajor}.${request.httpVersionMinor}`);
    lines.push(`request headers ${request.headers[":path"]} ${request.headers["x-t"]} ${typeof request.headers[":authority"]}`);
    lines.push(`request rawHeaders ${Array.isArray(request.rawHeaders)} ${request.rawHeaders.includes("x-t")}`);
    lines.push(`request socket ${typeof request.socket.remotePort} ${request.socket.remoteAddress} ${typeof request.connection.remotePort}`);
    request.setTimeout(5000, () => lines.push("request timeout"));
    lines.push(`response start ${response.statusCode} ${response.headersSent} ${response.finished} ${response.writableEnded} ${response.req === request}`);
    lines.push(`response socket ${typeof response.socket.remotePort} ${typeof response.connection.remotePort}`);
    response.setHeader("X-G", "v");
    response.setHeader("x-gone", "1");
    lines.push(`response getHeader ${response.getHeader("x-g")} ${response.getHeader("nope")} ${response.hasHeader("x-g")} ${response.hasHeader("nope")}`);
    response.removeHeader("x-gone");
    lines.push(`response removeHeader ${response.hasHeader("x-gone")}`);
    response.statusCode = 202;
    lines.push(`response statusCode ${response.statusCode}`);
    response.writeHead(201, { "x-w": "1" });
    lines.push(`response writeHead ${response.headersSent} ${response.statusCode}`);
    response.write("a");
    response.write("b");
    response.end("c", () => lines.push(`response end callback ${response.finished} ${response.writableEnded}`));
    lines.push(`response ended ${response.finished} ${response.writableEnded}`);
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    const request = client.request({ ":path": "/u", "x-t": "1" });
    let body = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => lines.push(`client response ${headers[":status"]} ${headers["x-w"]} ${headers["x-g"]} ${headers["x-gone"]}`));
    request.on("data", (chunk) => (body += chunk));
    request.on("close", () => {
      lines.push(`client body ${body}`);
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
