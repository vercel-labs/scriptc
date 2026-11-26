// HTTP/2's regular-field rules are part of the same request-block validation:
// field names are lowercase, the connection-specific fields are forbidden, and
// te may carry only "trailers". Each violation is
// RST_STREAM(PROTOCOL_ERROR) with nothing dispatched; a valid trailer block
// still reaches the handler with req.trailers.
import * as http2 from "node:http2";
import * as net from "node:net";

const server = http2.createServer((req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  req.resume();
  req.on("end", () => {
    console.log("dispatched", req.method, JSON.stringify(req.trailers));
    res.end("ok");
  });
});

const CONNECTION_HEADER = Buffer.from([
    80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
    0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 83, 1, 5, 0, 0, 0, 1, 0, 7, 58, 109, 101, 116,
    104, 111, 100, 3, 71, 69, 84, 0, 7, 58, 115, 99, 104, 101, 109, 101, 4, 104, 116, 116, 112, 0, 5, 58,
    112, 97, 116, 104, 1, 47, 0, 10, 58, 97, 117, 116, 104, 111, 114, 105, 116, 121, 11, 101, 120, 97, 109, 112,
    108, 101, 46, 99, 111, 109, 0, 10, 99, 111, 110, 110, 101, 99, 116, 105, 111, 110, 10, 107, 101, 101, 112, 45,
    97, 108, 105, 118, 101,
]);

const TE_GZIP = Buffer.from([
    80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
    0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 69, 1, 5, 0, 0, 0, 1, 0, 7, 58, 109, 101, 116,
    104, 111, 100, 3, 71, 69, 84, 0, 7, 58, 115, 99, 104, 101, 109, 101, 4, 104, 116, 116, 112, 0, 5, 58,
    112, 97, 116, 104, 1, 47, 0, 10, 58, 97, 117, 116, 104, 111, 114, 105, 116, 121, 11, 101, 120, 97, 109, 112,
    108, 101, 46, 99, 111, 109, 0, 2, 116, 101, 4, 103, 122, 105, 112,
]);

const VALID_TRAILERS = Buffer.from([
    80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
    0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 60, 1, 4, 0, 0, 0, 1, 0, 7, 58, 109, 101, 116,
    104, 111, 100, 3, 71, 69, 84, 0, 7, 58, 115, 99, 104, 101, 109, 101, 4, 104, 116, 116, 112, 0, 5, 58,
    112, 97, 116, 104, 1, 47, 0, 10, 58, 97, 117, 116, 104, 111, 114, 105, 116, 121, 11, 101, 120, 97, 109, 112,
    108, 101, 46, 99, 111, 109, 0, 0, 7, 1, 5, 0, 0, 0, 1, 0, 3, 120, 45, 116, 1, 49,
]);

const CASES: [string, Buffer][] = [
  ["connection header", CONNECTION_HEADER],
  ["te gzip", TE_GZIP],
  ["valid trailers", VALID_TRAILERS]
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
  setTimeout(nextRaw, 0);
}

const onRawData = (chunk: Buffer): void => {
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

function nextRaw(): void {
  if (index === CASES.length) {
    clientPhase();
    return;
  }
  const [label, bytes] = CASES[index]!;
  index += 1;
  current = label;
  seen = Buffer.alloc(0);
  finished = false;
  const sock = net.connect(port, "127.0.0.1", () => sock.write(bytes));
  peer = sock;
  sock.on("data", onRawData);
  sock.on("error", () => {});
  setTimeout(() => {
    if (finished) return;
    finished = true;
    console.log(current, "no answer");
    sock.destroy();
    nextRaw();
  }, 400);
}

function clientPhase(): void {
  const client = http2.connect("http://127.0.0.1:" + port);
  client.on("error", () => {});
  const ok = client.request({ ":path": "/ok" });
  ok.resume();
  ok.on("end", () => {
    client.destroy();
    server.close();
  });
  ok.end();
}

server.listen(0, "127.0.0.1", () => {
  port = (server.address() as net.AddressInfo).port;
  nextRaw();
});
