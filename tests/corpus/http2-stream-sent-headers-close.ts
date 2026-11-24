// The sent-header readbacks stay readable for the stream's lifetime: a
// 'close' listener and a read after 'close' both still see the
// sentHeaders/sentInfoHeaders/sentTrailers blocks that went out.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.additionalHeaders({ ":status": 103, "x-info": "a" });
    stream.respond({ ":status": 200, "x-a": "1" });
    stream.on("close", () => {
      const sent = stream.sentHeaders;
      lines.push(`server close sentHeaders ${sent[":status"]} ${sent["x-a"]}`);
      const info = stream.sentInfoHeaders;
      lines.push(`server close sentInfoHeaders ${info.length} ${info[0][":status"]}`);
      lines.push(`server close sentTrailers ${stream.sentTrailers === undefined}`);
    });
    stream.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const request = client.request({ ":path": "/close-readbacks", "x-req": "r" });
    request.on("data", () => {});
    request.on("end", () => {
      lines.push("client end");
    });
    request.on("close", () => {
      lines.push(`client close sentHeaders ${request.sentHeaders[":path"]}`);
      lines.push(`client close sentInfoHeaders ${request.sentInfoHeaders === undefined}`);
      setTimeout(() => {
        lines.push(`client later sentHeaders ${request.sentHeaders[":path"]}`);
        lines.push(`client later sentHeaders method ${request.sentHeaders[":method"]}`);
        client.close(() => {
          server.close(() => resolve());
        });
      }, 40);
    });
    request.end();
  });
});

for (const line of lines.sort()) console.log(line);
