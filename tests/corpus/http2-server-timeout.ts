// An Http2Server's timeout is a per-SESSION deadline, not a socket idle
// one: server.setTimeout(ms, cb) stores the value in the server's `timeout`
// property, every accepted session arms it, and the server's 'timeout'
// event fires with that session. Both the setTimeout callback and a
// listener added with on("timeout") run. Closing the session from the
// handler lets both ends finish; the lines are printed sorted.
import * as http2 from "node:http2";

const lines: string[] = [];
const server = http2.createServer();
lines.push(`default timeout ${server.timeout}`);
server.setTimeout(50, (session) => {
  lines.push(`callback session ${typeof session.alpnProtocol}`);
  session.close();
});
lines.push(`stored timeout ${server.timeout}`);
server.on("timeout", (session) => lines.push(`event session ${session.destroyed}`));
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 });
  stream.end("ok");
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`);
    client.on("close", () =>
      server.close(() => {
        for (const line of lines.sort()) console.log(line);
        resolve();
      }),
    );
  });
});
