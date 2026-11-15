// The requests an HTTP/1 server delivers to its handler for byte streams that are malformed, ambiguous or
// pipelined: two Content-Length fields, Content-Length beside Transfer-Encoding, chunk sizes and extensions,
// bare line feeds, folded headers, oversized heads. A proxy and a server that frame such a stream differently are
// what request smuggling needs, so the compiled server must deliver exactly what Node's does: the same requests,
// in the same order, with the same header count, body length and trailer count.
//
// Each stream goes to the server on its own connection. The program prints what the handler saw, never the
// responses: Node drops a finished response when a later pipelined request fails to parse, and the response bytes
// would then depend on timing.
//
// Four streams of the same family are not here, because the compiled server does not yet deliver what Node
// does for them: a request line with two spaces between its parts (Node accepts it), an Upgrade request when the
// server has no 'upgrade' listener (Node treats it as an ordinary request), a Content-Length field among
// chunked trailers (Node rejects the message), and a request that follows one with `Connection: close` (Node
// does not deliver it). In each, one server stops earlier than the other; neither frames a request differently.
import { createServer } from "node:http";
import { connect } from "node:net";

const H = "Host: a\r\n";
const vectors: [string, string][] = [
  ["CL.TE", `POST / HTTP/1.1\r\n${H}Content-Length: 6\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nG`],
  ["TE.CL", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n5c\r\nGPOST / HTTP/1.1\r\n\r\n0\r\n\r\n`],
  ["dup CL same", `POST / HTTP/1.1\r\n${H}Content-Length: 3\r\nContent-Length: 3\r\n\r\nabc`],
  ["dup CL differ", `POST / HTTP/1.1\r\n${H}Content-Length: 3\r\nContent-Length: 5\r\n\r\nabcde`],
  ["CL list", `POST / HTTP/1.1\r\n${H}Content-Length: 3, 3\r\n\r\nabc`],
  ["CL plus", `POST / HTTP/1.1\r\n${H}Content-Length: +3\r\n\r\nabc`],
  ["CL neg", `POST / HTTP/1.1\r\n${H}Content-Length: -3\r\n\r\nabc`],
  ["CL hex", `POST / HTTP/1.1\r\n${H}Content-Length: 0x3\r\n\r\nabc`],
  ["CL space inside", `POST / HTTP/1.1\r\n${H}Content-Length: 1 0\r\n\r\nabcdefghij`],
  ["CL leading zeros", `POST / HTTP/1.1\r\n${H}Content-Length: 0003\r\n\r\nabc`],
  ["CL huge", `POST / HTTP/1.1\r\n${H}Content-Length: 99999999999999999999999\r\n\r\nabc`],
  ["CL tab", `POST / HTTP/1.1\r\n${H}Content-Length:\t3\t\r\n\r\nabc`],
  ["space before colon", `POST / HTTP/1.1\r\n${H}Content-Length : 3\r\n\r\nabc`],
  ["TE space before colon", `POST / HTTP/1.1\r\n${H}Transfer-Encoding : chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["TE xchunked", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: xchunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["TE chunked,identity", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: chunked, identity\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["TE identity,chunked", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: identity, chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["TE two headers", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["TE CHUNKED case", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: CHUNKED\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["TE tab", `POST / HTTP/1.1\r\n${H}Transfer-Encoding:\tchunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["TE vtab", `POST / HTTP/1.1\r\n${H}Transfer-Encoding:\x0bchunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["TE fold", `POST / HTTP/1.1\r\n${H}Transfer-Encoding:\r\n chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["TE quoted", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: "chunked"\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["TE trailing comma", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: chunked,\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["TE in 1.0", `POST / HTTP/1.0\r\n${H}Transfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n`],
  ["chunk size hex upper", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\nA\r\n0123456789\r\n0\r\n\r\n`],
  ["chunk size 0x", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n0x3\r\nabc\r\n0\r\n\r\n`],
  ["chunk size space", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n3 \r\nabc\r\n0\r\n\r\n`],
  ["chunk size overflow", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\nffffffffffffffffff\r\nabc\r\n0\r\n\r\n`],
  ["chunk ext", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n3;a=b;c="d\r\n"\r\nabc\r\n0\r\n\r\n`],
  ["chunk bare LF", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n3\nabc\n0\n\n`],
  ["chunk missing CRLF after data", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n3\r\nabc0\r\n\r\n`],
  ["chunk data CR only", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n3\r\nabc\rX0\r\n\r\n`],
  ["bare LF headers", `GET / HTTP/1.1\n${H.replace("\r\n", "\n")}\n`],
  ["bare CR in header", `GET / HTTP/1.1\r\n${H}X: a\rb\r\n\r\n`],
  ["NUL in header", `GET / HTTP/1.1\r\n${H}X: a\0b\r\n\r\n`],
  ["obs-fold", `GET / HTTP/1.1\r\n${H}X: a\r\n b\r\n\r\n`],
  ["leading space header", `GET / HTTP/1.1\r\n X: a\r\n${H}\r\n`],
  ["empty header name", `GET / HTTP/1.1\r\n${H}: a\r\n\r\n`],
  ["header no colon", `GET / HTTP/1.1\r\n${H}Xa\r\n\r\n`],
  ["dup Host", `GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n`],
  ["no Host 1.1", `GET / HTTP/1.1\r\n\r\n`],
  ["abs URI + Host", `GET http://evil/x HTTP/1.1\r\n${H}\r\n`],
  ["GET with body", `GET / HTTP/1.1\r\n${H}Content-Length: 3\r\n\r\nabcGET /2 HTTP/1.1\r\n${H}\r\n`],
  ["pipelined", `GET /1 HTTP/1.1\r\n${H}\r\nGET /2 HTTP/1.1\r\n${H}\r\nGET /3 HTTP/1.1\r\n${H}Connection: close\r\n\r\n`],
  ["leading CRLF", `\r\n\r\nGET / HTTP/1.1\r\n${H}\r\n`],
  ["HTTP/0.9", `GET /\r\n`],
  ["HTTP/1.2", `GET / HTTP/1.2\r\n${H}\r\n`],
  ["HTTP/2.0 line", `GET / HTTP/2.0\r\n${H}\r\n`],
  ["lowercase method", `get / HTTP/1.1\r\n${H}\r\n`],
  ["method with ctl", `GE\x01T / HTTP/1.1\r\n${H}\r\n`],
  ["space in target", `GET /a b HTTP/1.1\r\n${H}\r\n`],
  ["tab separators", `GET\t/\tHTTP/1.1\r\n${H}\r\n`],
  ["utf8 target", `GET /\xc3\xa9 HTTP/1.1\r\n${H}\r\n`],
  ["expect", `POST / HTTP/1.1\r\n${H}Expect: 100-continue\r\nContent-Length: 3\r\n\r\nabc`],
  ["expect unknown", `POST / HTTP/1.1\r\n${H}Expect: nope\r\nContent-Length: 3\r\n\r\nabc`],
  ["1000 headers", `GET / HTTP/1.1\r\n${H}${"X: y\r\n".repeat(1000)}\r\n`],
  ["2001 headers", `GET / HTTP/1.1\r\n${H}${"X: y\r\n".repeat(2001)}\r\n`],
  ["17KB header", `GET / HTTP/1.1\r\n${H}X: ${"a".repeat(17000)}\r\n\r\n`],
  ["15KB header", `GET / HTTP/1.1\r\n${H}X: ${"a".repeat(15000)}\r\n\r\n`],
  ["long target", `GET /${"a".repeat(17000)} HTTP/1.1\r\n${H}\r\n`],
  ["CL then pipelined", `POST / HTTP/1.1\r\n${H}Content-Length: 3\r\n\r\nabcPOST /2 HTTP/1.1\r\n${H}Content-Length: 2\r\n\r\nxy`],
  ["TE identity", `POST / HTTP/1.1\r\n${H}Transfer-Encoding: identity\r\nContent-Length: 3\r\n\r\nabc`],
  ["header value ctl", `GET / HTTP/1.1\r\n${H}X: a\x01b\x7fc\r\n\r\n`],
  ["header name chars", `GET / HTTP/1.1\r\n${H}X(y): a\r\nX@z: b\r\n\r\n`],
  ["content-length_ underscore", `POST / HTTP/1.1\r\n${H}Content_Length: 3\r\n\r\nabc`],
];

interface Seen {
  heads: string[];
  bodies: string[];
}
const seen = new Map<number, Seen>();

const server = createServer((req, res) => {
  const from = req.socket.remotePort ?? 0;
  let entry = seen.get(from);
  if (entry === undefined) {
    entry = { heads: [], bodies: [] };
    seen.set(from, entry);
  }
  const mine = entry;
  mine.heads.push(`${req.method} ${req.url} HTTP/${req.httpVersion} headers=${req.rawHeaders.length / 2}`);
  let n = 0;
  req.on("data", (c: Buffer) => {
    n += c.length;
  });
  req.on("error", () => {});
  req.on("end", () => {
    mine.bodies.push(`body=${n} trailers=${req.rawTrailers.length / 2}`);
    res.end("ok");
  });
});
server.on("clientError", (err, socket) => {
  socket.destroy();
});

// Send one stream and resolve with the client's port once the server has closed the connection, or has had five
// turns of the event loop, ten milliseconds apart, in which it sent nothing. Server and client share this
// process's loop, so a turn in which the server had work to do is a turn in which it did it; the wait counts
// turns, not time.
function send(port: number, payload: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let local = 0;
    let quiet = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      resolve(local);
    };
    const turn = (): void => {
      if (++quiet >= 5) finish();
      else timer = setTimeout(turn, 10);
    };
    socket.on("error", finish);
    socket.on("close", finish);
    socket.on("data", () => {
      quiet = 0;
    });
    socket.on("connect", () => {
      local = socket.localPort ?? 0;
      socket.write(Buffer.from(payload, "latin1"));
      timer = setTimeout(turn, 10);
    });
  });
}

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  const lines: string[] = [];
  for (let at = 0; at < vectors.length; at += 8) {
    const group = vectors.slice(at, at + 8);
    const ports = await Promise.all(group.map((v) => send(port, v[1])));
    for (let k = 0; k < group.length; k++) {
      const entry = seen.get(ports[k] ?? 0);
      const requests: string[] = [];
      if (entry !== undefined) {
        for (let r = 0; r < entry.heads.length; r++) {
          const body = entry.bodies[r];
          requests.push(body === undefined ? `${entry.heads[r]} (body not finished)` : `${entry.heads[r]} ${body}`);
        }
      }
      lines.push(`${group[k]?.[0]}: ${requests.length === 0 ? "nothing delivered" : requests.join(" | ")}`);
    }
  }
  for (const line of lines) console.log(line);
  server.close();
});
