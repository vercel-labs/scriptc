// A rejected trailer block on a stream the program already holds reports the
// protocol error to the raw stream, as Node's nghttp2 does: the listener sees
// ERR_HTTP2_STREAM_ERROR and the peer sees RST_STREAM(PROTOCOL_ERROR). The
// block here is a non-terminal HEADERS on a dispatched request.
import * as http2 from "node:http2";
import * as net from "node:net";

const server = http2.createServer((req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  console.log("dispatched", req.method, JSON.stringify(req.url));
  req.resume();
  req.on("end", () => res.end("ok"));
});
server.on("stream", (stream: http2.ServerHttp2Stream) => {
  stream.on("error", (e) => console.log("stream error", (e as { code?: string }).code));
});

// a GET block without END_STREAM, then a second non-terminal HEADERS block
const NONTERMINAL = Buffer.from([
  80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
  0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 50, 1, 4, 0, 0, 0, 1, 0, 7, 58, 109, 101, 116,
  104, 111, 100, 3, 71, 69, 84, 0, 7, 58, 115, 99, 104, 101, 109, 101, 4, 104, 116, 116, 112, 0, 5, 58,
  112, 97, 116, 104, 1, 47, 0, 10, 58, 97, 117, 116, 104, 111, 114, 105, 116, 121, 1, 120, 0, 0, 7, 1,
  4, 0, 0, 0, 1, 0, 3, 120, 45, 116, 1, 49
]);

const CASES: [string, Buffer][] = [["nonterminal", NONTERMINAL]];

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
  setTimeout(next, 0);
}

const onData = (chunk: Buffer): void => {
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
};

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
