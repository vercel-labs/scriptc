// node:http2 server.close(): it stops listening and closes every live
// session the way Node does — each session sends GOAWAY and finishes once
// its streams drain (an in-flight response still completes), the client's
// 'goaway' fires for the close's two GOAWAY frames, and the server's
// 'close' callback runs after the session closed.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
const lines: string[] = [];
const server = http2.createServer();
server.on("session", (session) => {
  lines.push("server session");
  session.on("close", () => lines.push("server session close"));
});
server.on("stream", (stream, headers) => {
  const path = String(headers[":path"]);
  lines.push(`server stream ${path}`);
  if (path === "/slow") {
    stream.on("close", () => lines.push("server slow stream close"));
    setTimeout(() => {
      lines.push("server slow respond");
      stream.respond({ ":status": 200 });
      stream.end("slow body");
    }, 80);
  } else {
    stream.respond({ ":status": 200 });
    stream.end("fast body");
  }
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("goaway", (errorCode: number, lastStreamID: number) => {
    lines.push(`client goaway ${errorCode} ${lastStreamID}`);
  });
  client.on("close", () => {
    lines.push("client session close");
    server.close(() => {
      lines.push("server close callback");
      for (const line of lines) console.log(line);
      process.exit(0);
    });
  });
  const slow = client.request({ ":path": "/slow" });
  slow.on("data", (chunk) => lines.push(`client slow data ${String(chunk)}`));
  slow.on("end", () => lines.push("client slow end"));
  slow.resume();
  slow.end();
  const fast = client.request({ ":path": "/fast" });
  fast.on("data", (chunk) => lines.push(`client fast data ${String(chunk)}`));
  fast.on("end", () => {
    lines.push("client fast end");
    server.close();
  });
  fast.resume();
  fast.end();
});
