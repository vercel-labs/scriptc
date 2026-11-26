// Connection-level receive credit returns as DATA arrives, so one stream
// whose body nobody reads cannot starve the session's other streams: the
// unread stream stays parked at its own receive window (65535 bytes) while
// a second stream keeps draining (Node's nghttp2 does the same).
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const WINDOW = 65535;
const BODY = 200000;
const body = Buffer.alloc(BODY, 0x62);
const lines: string[] = [];

const server = http2.createServer();
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 });
  stream.end(body);
  stream.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  // the first stream's body is never read
  const held = client.request({ ":path": "/held" });
  let heldBytes = 0;
  held.on("data", (chunk: Buffer) => {
    heldBytes += chunk.length;
  });
  held.on("error", () => {});
  held.on("response", () => held.pause());
  // the second stream reads its whole body
  const flow = client.request({ ":path": "/flow" });
  let flowBytes = 0;
  flow.on("data", (chunk: Buffer) => {
    flowBytes += chunk.length;
  });
  flow.on("error", () => {});
  flow.on("end", () => {
    lines.push(`flow ${flowBytes === BODY ? "full" : flowBytes}`);
  });
  setTimeout(() => {
    lines.push(`held ${heldBytes === BODY ? "full" : heldBytes <= WINDOW ? "parked" : "past window"}`);
    client.destroy();
    server.close(() => {
      for (const line of lines) console.log(line);
    });
  }, 600);
});
