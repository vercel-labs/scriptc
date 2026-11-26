// The extended CONNECT gate is the SERVER's advertisement: a client may send
// :protocol only when the server enabled settings.enableConnectProtocol. A
// default client (no setting of its own) is therefore accepted, exactly as in
// Node; the server here is created with that option, which the h2c server now
// honors. The peer writes the frame raw so the client's SETTINGS are exact.
import * as http2 from "node:http2";
import * as net from "node:net";

const server = http2.createServer(
  { settings: { enableConnectProtocol: true } },
  (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
    res.end("ok");
  },
);
server.on(
  "connect",
  (req: http2.Http2ServerRequest, resOrSocket: http2.Http2ServerResponse | net.Socket) => {
    console.log("dispatched", req.method, JSON.stringify(req.url ?? null));
    if (!(resOrSocket instanceof net.Socket)) {
      resOrSocket.writeHead(200);
      resOrSocket.end();
    }
  },
);

// preface + SETTINGS (empty: the default client) + extended CONNECT HEADERS
const CLIENT_SILENT = Buffer.from([
  80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
  0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 77, 1, 5, 0, 0, 0, 1, 0, 7, 58, 109, 101, 116,
  104, 111, 100, 7, 67, 79, 78, 78, 69, 67, 84, 0, 9, 58, 112, 114, 111, 116, 111, 99, 111, 108, 9, 119,
  101, 98, 115, 111, 99, 107, 101, 116, 0, 7, 58, 115, 99, 104, 101, 109, 101, 4, 104, 116, 116, 112, 0, 5,
  58, 112, 97, 116, 104, 3, 47, 119, 115, 0, 10, 58, 97, 117, 116, 104, 111, 114, 105, 116, 121, 1, 120
]);
// the same with SETTINGS_ENABLE_CONNECT_PROTOCOL = 1 from the client
const CLIENT_ENABLES = Buffer.from([
  80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
  0, 0, 6, 4, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 1, 0, 0, 77, 1, 5, 0, 0, 0, 1,
  0, 7, 58, 109, 101, 116, 104, 111, 100, 7, 67, 79, 78, 78, 69, 67, 84, 0, 9, 58, 112, 114, 111, 116,
  111, 99, 111, 108, 9, 119, 101, 98, 115, 111, 99, 107, 101, 116, 0, 7, 58, 115, 99, 104, 101, 109, 101, 4,
  104, 116, 116, 112, 0, 5, 58, 112, 97, 116, 104, 3, 47, 119, 115, 0, 10, 58, 97, 117, 116, 104, 111, 114,
  105, 116, 121, 1, 120
]);

const CASES: [string, Buffer][] = [
  ["client-silent", CLIENT_SILENT],
  ["client-enables", CLIENT_ENABLES],
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
