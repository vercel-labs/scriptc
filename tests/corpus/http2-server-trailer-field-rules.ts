// HTTP/2 trailer blocks follow nghttp2's receive rules like every other block:
// no pseudo-header field, a lowercase field name, and no connection-specific
// field. A block that breaks them is RST_STREAM(PROTOCOL_ERROR) — the request
// still completes (aborted, empty req.trailers), the raw stream reports
// ERR_HTTP2_STREAM_ERROR, and no 'trailers' event fires. A valid trailer block
// still reaches req.trailers.
import * as http2 from "node:http2";
import * as net from "node:net";

const server = http2.createServer((req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  req.resume();
  req.on("aborted", () => console.log("srv aborted"));
  req.on("end", () => {
    console.log("srv end", req.aborted === true, req.complete, JSON.stringify(req.trailers));
    res.end("ok");
  });
});
server.on("stream", (stream: http2.ServerHttp2Stream) => {
  stream.on("trailers", (t) => console.log("srv stream trailers", JSON.stringify(t)));
  stream.on("error", (e) => console.log("srv stream error", (e as { code?: string }).code));
});
const VALID_TRAILERS = Buffer.from([
    80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
    0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 60, 1, 4, 0, 0, 0, 1, 0, 7, 58, 109, 101, 116,
    104, 111, 100, 3, 71, 69, 84, 0, 7, 58, 115, 99, 104, 101, 109, 101, 4, 104, 116, 116, 112, 0, 5, 58,
    112, 97, 116, 104, 1, 47, 0, 10, 58, 97, 117, 116, 104, 111, 114, 105, 116, 121, 11, 101, 120, 97, 109, 112,
    108, 101, 46, 99, 111, 109, 0, 0, 7, 1, 5, 0, 0, 0, 1, 0, 3, 120, 45, 116, 1, 49,
]);
const PSEUDO_TRAILER = Buffer.from([
    80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
    0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 60, 1, 4, 0, 0, 0, 1, 0, 7, 58, 109, 101, 116,
    104, 111, 100, 3, 71, 69, 84, 0, 7, 58, 115, 99, 104, 101, 109, 101, 4, 104, 116, 116, 112, 0, 5, 58,
    112, 97, 116, 104, 1, 47, 0, 10, 58, 97, 117, 116, 104, 111, 114, 105, 116, 121, 11, 101, 120, 97, 109, 112,
    108, 101, 46, 99, 111, 109, 0, 0, 13, 1, 5, 0, 0, 0, 1, 0, 5, 58, 112, 97, 116, 104, 5, 47,
    101, 118, 105, 108,
]);
const CONNECTION_TRAILER = Buffer.from([
    80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
    0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 60, 1, 4, 0, 0, 0, 1, 0, 7, 58, 109, 101, 116,
    104, 111, 100, 3, 71, 69, 84, 0, 7, 58, 115, 99, 104, 101, 109, 101, 4, 104, 116, 116, 112, 0, 5, 58,
    112, 97, 116, 104, 1, 47, 0, 10, 58, 97, 117, 116, 104, 111, 114, 105, 116, 121, 11, 101, 120, 97, 109, 112,
    108, 101, 46, 99, 111, 109, 0, 0, 23, 1, 5, 0, 0, 0, 1, 0, 10, 99, 111, 110, 110, 101, 99, 116,
    105, 111, 110, 10, 107, 101, 101, 112, 45, 97, 108, 105, 118, 101,
]);
const UPPERCASE_TRAILER = Buffer.from([
    80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
    0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 60, 1, 4, 0, 0, 0, 1, 0, 7, 58, 109, 101, 116,
    104, 111, 100, 3, 71, 69, 84, 0, 7, 58, 115, 99, 104, 101, 109, 101, 4, 104, 116, 116, 112, 0, 5, 58,
    112, 97, 116, 104, 1, 47, 0, 10, 58, 97, 117, 116, 104, 111, 114, 105, 116, 121, 11, 101, 120, 97, 109, 112,
    108, 101, 46, 99, 111, 109, 0, 0, 9, 1, 5, 0, 0, 0, 1, 0, 5, 88, 45, 85, 80, 80, 1, 49,
]);
const CASES: [string, Buffer][] = [
  ["pseudo", PSEUDO_TRAILER],
  ["connection", CONNECTION_TRAILER],
  ["uppercase", UPPERCASE_TRAILER],
  ["valid", VALID_TRAILERS],
];

let port = 0;
let index = 0;
let current = "";
let seen = Buffer.alloc(0);
let peer: net.Socket | null = null;
let finished = false;

function finish(): void {
  if (finished) return;
  finished = true;
  if (peer !== null) peer.destroy();
  setTimeout(next, 20);
}

function onData(chunk: Buffer): void {
  seen = Buffer.concat([seen, chunk]);
  while (seen.length >= 9) {
    const len = seen.readUIntBE(0, 3);
    if (seen.length < 9 + len) break;
    const type = seen.readUInt8(3);
    const body = seen.subarray(9, 9 + len);
    if (type === 3) {
      console.log(current, "RST", body.readUInt32BE(0));
      finish();
      return;
    }
    if (type === 1) {
      console.log(current, "response");
      finish();
      return;
    }
    seen = seen.subarray(9 + len);
  }
}

function next(): void {
  if (index === CASES.length) {
    server.close();
    return;
  }
  const [label, bytes] = CASES[index]!;
  index += 1;
  current = label;
  seen = Buffer.alloc(0);
  finished = false;
  const sock = net.connect(port, "127.0.0.1", () => sock.write(bytes));
  peer = sock;
  sock.on("data", onData);
  sock.on("error", () => {});
  setTimeout(() => {
    if (finished) return;
    finished = true;
    console.log(current, "no answer");
    sock.destroy();
    next();
  }, 400);
}

server.listen(0, "127.0.0.1", () => {
  port = (server.address() as net.AddressInfo).port;
  next();
});
