// A request that races a graceful server.close(): the peer opens a stream
// after the first GOAWAY (the client had not seen it yet). The server
// refuses that stream, and the shutdown notice that follows keeps the FIRST
// GOAWAY's last-stream id — RFC 9113 6.8 says a GOAWAY's last stream
// identifier must not increase, and Node/nghttp2 repeat the id the close
// began with. The in-flight response still completes.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const goaways: string[] = [];
let serverLateStreams = 0;
let slowData = "";
let lateError = "none";
let lateResponded = false;

const server = http2.createServer();
server.on("stream", (stream, headers) => {
  const path = String(headers[":path"]);
  if (path !== "/slow") {
    serverLateStreams++;
    stream.respond({ ":status": 200 });
    stream.end("late");
    return;
  }
  stream.respond({ ":status": 200 });
  server.close();
  setTimeout(() => stream.end("slow"), 120);
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("goaway", (code: number, lastStreamID: number) => {
    goaways.push(`${code}:${lastStreamID}`);
  });
  client.on("close", () => {
    lines.push(`goaways ${goaways.join(" ")}`);
    lines.push(`late error ${lateError}`);
    lines.push(`late response ${lateResponded}`);
    lines.push(`server late streams ${serverLateStreams}`);
    lines.push(`slow data ${slowData}`);
    for (const line of lines) console.log(line);
    process.exit(0);
  });
  const slow = client.request({ ":path": "/slow" });
  slow.on("response", () => {
    const late = client.request({ ":path": "/late" });
    late.on("error", (error) => {
      lateError = String((error as NodeJS.ErrnoException).code);
    });
    late.on("response", () => {
      lateResponded = true;
    });
    late.resume();
    late.end();
  });
  slow.setEncoding("utf8");
  slow.on("data", (chunk) => {
    slowData += chunk;
  });
  slow.resume();
  slow.end();
});
