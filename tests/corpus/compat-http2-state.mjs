// State members of node:http2 streams on both ends of a completed request:
// a server stream's headersSent before and after respond(), and closed,
// destroyed and rstCode before the request, at 'end' and in 'close'. A
// stream is closed and destroyed in its 'close' listener after a normal
// end as well as after a reset. The two ends race, so each records its own
// lines.
import http2 from "node:http2";

await new Promise((resolve) => {
  const clientLines = [];
  const serverLines = [];
  const server = http2.createServer();
  server.on("stream", (stream) => {
    serverLines.push(`new ${stream.headersSent} ${stream.destroyed} ${stream.closed}`);
    stream.respond({ ":status": 200 });
    serverLines.push(`responded ${stream.headersSent}`);
    stream.on("close", () => serverLines.push(`close ${stream.headersSent} ${stream.destroyed} ${stream.closed} ${stream.rstCode}`));
    stream.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    const request = client.request({ ":path": "/" });
    clientLines.push(`new ${request.destroyed} ${request.closed} ${request.aborted}`);
    request.on("response", () => clientLines.push(`response ${request.destroyed} ${request.closed}`));
    request.on("end", () => clientLines.push(`end ${request.destroyed}`));
    request.resume();
    request.on("close", () => {
      clientLines.push(`close ${request.destroyed} ${request.closed} ${request.rstCode} ${request.aborted}`);
      setTimeout(
        () =>
          client.close(() =>
            server.close(() => {
              console.log(`client ${clientLines.join(" | ")}`);
              console.log(`server ${serverLines.join(" | ")}`);
              resolve(undefined);
            }),
          ),
        30,
      );
    });
    request.end();
  });
});
