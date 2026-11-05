// The server's request parser applies Node's checks: a malformed request
// line, header line, Content-Length or Transfer-Encoding, or chunk is
// answered with 400 Bad Request and the connection closes, and a chunk with
// more than 16 KiB of extensions is answered with 413. Valid edge cases
// (extra spaces before the target, whitespace around values, obs-text,
// chunk extensions, leading zeros) reach the handler.
import * as http from "node:http";
import * as net from "node:net";

const cases: [string, string][] = [
  ["space before colon", "GET / HTTP/1.1\r\nHost: a\r\nContent-Length : 5\r\n\r\nhello"],
  ["cl and te", "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"],
  ["te and cl", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n0\r\n\r\n"],
  ["te not chunked", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip\r\n\r\n"],
  ["te chunked then gzip", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked, gzip\r\n\r\n"],
  ["te repeated", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"],
  ["te substring", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: xchunked\r\n\r\n"],
  ["te gzip chunked", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip, chunked\r\n\r\n2\r\nab\r\n0\r\n\r\n"],
  ["te upper", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: CHUNKED\r\n\r\n2\r\nab\r\n0\r\n\r\n"],
  ["cl not digits", "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1x\r\n\r\nx"],
  ["cl negative", "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: -1\r\n\r\n"],
  ["cl duplicate", "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx"],
  ["cl list", "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1, 1\r\n\r\nx"],
  ["cl empty", "POST / HTTP/1.1\r\nHost: a\r\nContent-Length:\r\n\r\n"],
  ["cl overflow", "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 99999999999999999999\r\n\r\n"],
  ["cl spaces", "POST / HTTP/1.1\r\nHost: a\r\nContent-Length:  1  \r\n\r\nx"],
  ["cl leading zeros", "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 003\r\n\r\nabc"],
  ["bare cr", "GET / HTTP/1.1\r\nHost: a\r\nX-A: b\rc\r\n\r\n"],
  ["bare lf", "GET / HTTP/1.1\nHost: a\n\n"],
  ["lf in headers", "GET / HTTP/1.1\r\nHost: a\nX-A: b\r\n\r\n"],
  ["nul in value", "GET / HTTP/1.1\r\nHost: a\r\nX-A: b\u0000c\r\n\r\n"],
  ["del in value", "GET / HTTP/1.1\r\nHost: a\r\nX-A: b\u007fc\r\n\r\n"],
  ["tab in value", "GET / HTTP/1.1\r\nHost: a\r\nX-A: b\tc\r\n\r\n"],
  ["obs-text value", "GET / HTTP/1.1\r\nHost: a\r\nX-A: café\r\n\r\n"],
  ["bad name", "GET / HTTP/1.1\r\nHost: a\r\nX(A): b\r\n\r\n"],
  ["empty name", "GET / HTTP/1.1\r\nHost: a\r\n: b\r\n\r\n"],
  ["obs fold", "GET / HTTP/1.1\r\nHost: a\r\nX-A: b\r\n c\r\n\r\n"],
  ["leading space line", "GET / HTTP/1.1\r\n Host: a\r\n\r\n"],
  ["method lowercase", "get / HTTP/1.1\r\nHost: a\r\n\r\n"],
  ["method unknown", "FOO / HTTP/1.1\r\nHost: a\r\n\r\n"],
  ["method m-search", "M-SEARCH * HTTP/1.1\r\nHost: a\r\n\r\n"],
  ["two spaces", "GET  / HTTP/1.1\r\nHost: a\r\n\r\n"],
  ["leading crlf", "\r\nGET / HTTP/1.1\r\nHost: a\r\n\r\n"],
  ["url space", "GET /a b HTTP/1.1\r\nHost: a\r\n\r\n"],
  ["url ctl", "GET /a\u0001b HTTP/1.1\r\nHost: a\r\n\r\n"],
  ["url high", "GET /café HTTP/1.1\r\nHost: a\r\n\r\n"],
  ["url no slash", "GET abc HTTP/1.1\r\nHost: a\r\n\r\n"],
  ["url absolute", "GET http://a/b HTTP/1.1\r\nHost: a\r\n\r\n"],
  ["url punctuation", "GET /a\"b<c>{d}|e^f`g\\h HTTP/1.1\r\nHost: a\r\n\r\n"],
  ["version 1.2", "GET / HTTP/1.2\r\nHost: a\r\n\r\n"],
  ["version lowercase", "GET / http/1.1\r\nHost: a\r\n\r\n"],
  ["version trailing space", "GET / HTTP/1.1 \r\nHost: a\r\n\r\n"],
  ["chunk size bad", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nab\r\n0\r\n\r\n"],
  ["chunk size space", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n2 \r\nab\r\n0\r\n\r\n"],
  ["chunk size overflow", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\nffffffffffffffffff\r\nab\r\n0\r\n\r\n"],
  ["chunk bare lf", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n2\nab\r\n0\r\n\r\n"],
  ["chunk data end", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nabXX0\r\n\r\n"],
  ["chunk ext", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n2;a=b;c;d=\"e f\"\r\nab\r\n0;x=y\r\n\r\n"],
  ["chunk ext empty", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n2;\r\nab\r\n0\r\n\r\n"],
  ["chunk ext bad", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n2;a b\r\nab\r\n0\r\n\r\n"],
  ["chunk ext overflow", `POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n2;${"a".repeat(17000)}\r\nab\r\n0\r\n\r\n`],
  ["chunk leading zeros", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0002\r\nab\r\n0\r\n\r\n"],
  ["trailer", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n0\r\nX-T: v\r\n\r\n"],
  ["trailer bad name", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX T: v\r\n\r\n"],
  ["trailer ctl", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: y\u0001\r\n\r\n"],
  ["trailer bare lf", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: y\n\r\n"],
  ["trailer end bare lf", "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\n"],
];

const server = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
  });
  req.on("end", () => {
    res.end(`${req.method} ${req.url} ${JSON.stringify(body)} ${JSON.stringify(req.trailers)}`);
  });
});

function send(port: number, index: number): void {
  if (index === cases.length) {
    server.close();
    return;
  }
  const [name, raw] = cases[index]!;
  const sock = net.connect(port, "127.0.0.1", () => {
    sock.write(Buffer.from(raw, "latin1"));
  });
  let reply = "";
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    const status = reply.split("\r\n")[0];
    const at = reply.indexOf("\r\n\r\n");
    const body = status!.startsWith("HTTP/1.1 200") && at >= 0 ? reply.slice(at + 4) : "";
    console.log(`${name}: ${status} ${body}`);
    sock.destroy();
    send(port, index + 1);
  };
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    reply += chunk;
    // a served request keeps the connection open: its body ends the case
    if (reply.startsWith("HTTP/1.1 200") && /\r\n\r\n[\s\S]*}$/.test(reply)) finish();
  });
  sock.on("error", () => {});
  sock.on("close", finish);
}

server.listen(0, "127.0.0.1", () => {
  send((server.address() as net.AddressInfo).port, 0);
});
