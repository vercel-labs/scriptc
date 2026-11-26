// A malformed HTTP/2 request block is a stream protocol error: the server
// answers RST_STREAM(PROTOCOL_ERROR) and never dispatches the request, so a
// router can never see the undefined url a :path-less block would produce.
// The peer here writes raw frames, because no client would compose them; an
// empty :path (which a client CAN send) is rejected the same way.
import * as http2 from "node:http2";
import * as net from "node:net";

const server = http2.createServer((req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  console.log("dispatched", req.method, JSON.stringify(req.url));
  res.end("ok");
});

// A request block with :method, :scheme and :authority but no :path, sent
// as raw bytes (no client would compose it): the preface, an empty
// SETTINGS frame, then HEADERS on stream 1 with END_HEADERS|END_STREAM.
const MISSING_PATH = Buffer.from([
  80,82,73,32,42,32,72,84,84,80,47,50,46,48,13,10,13,10,83,77,13,10,13,10,0,0,0,4,0,0,0,0,0,0,0,
  51,1,5,0,0,0,1,0,7,58,109,101,116,104,111,100,3,71,69,84,0,7,58,115,99,104,101,109,101,4,104,
  116,116,112,0,10,58,97,117,116,104,111,114,105,116,121,11,101,120,97,109,112,108,101,46,99,111,
  109,
]);

let port = 0;

const rest = (): void => {
  const client = http2.connect("http://127.0.0.1:" + port);
  client.on("error", () => {});
  const ok = client.request({ ":path": "/ok" });
  ok.resume();
  ok.on("end", () => {
    const empty = client.request({ ":scheme": "http", ":path": "" });
    empty.on("error", (e) => {
      console.log("empty path", (e as { code?: string }).code, e.message);
      client.destroy();
      server.close();
    });
    empty.resume();
    empty.end();
  });
  ok.end();
};

server.listen(0, "127.0.0.1", () => {
  port = (server.address() as net.AddressInfo).port;
  const raw = net.connect(port, "127.0.0.1", () => raw.write(MISSING_PATH));
  let buf = Buffer.alloc(0);
  raw.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 9) {
      const len = buf.readUIntBE(0, 3);
      if (buf.length < 9 + len) break;
      const type = buf.readUInt8(3);
      if (type === 3) {
        console.log("missing path RST", buf.subarray(9, 9 + len).readUInt32BE(0));
        raw.destroy();
        rest();
        return;
      }
      buf = buf.subarray(9 + len);
    }
  });
  raw.on("error", () => {});
});
