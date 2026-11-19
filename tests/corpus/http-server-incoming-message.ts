// Server-side IncomingMessage state: method/url/httpVersion, the headers
// snapshot (duplicate general fields join, known single-value fields drop
// unless joinDuplicateHeaders, cookie joins with "; ", set-cookie stays an
// array), rawHeaders case and order, headersDistinct, chunked trailers
// with rawTrailers/trailersDistinct, complete on end, and close after.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";

function show(label: string, value: unknown): void {
  console.log(label, JSON.stringify(value));
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const label = String(req.url).split("/")[1];
  show(`${label} line`, [req.method, req.url, req.httpVersion]);
  show(`${label} headers`, req.headers);
  show(`${label} raw`, req.rawHeaders);
  const distinct: Record<string, string[] | undefined> = {};
  for (const [name, values] of Object.entries(req.headersDistinct)) distinct[name] = values;
  show(`${label} distinct`, distinct);
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });
  req.on("end", () => {
    show(`${label} body`, [body, req.complete, req.aborted]);
    show(`${label} trailers`, req.trailers);
    show(`${label} rawTrailers`, req.rawTrailers);
    const trailerDistinct: Record<string, string[] | undefined> = {};
    for (const [name, values] of Object.entries(req.trailersDistinct)) trailerDistinct[name] = values;
    show(`${label} trailer distinct`, trailerDistinct);
    res.writeHead(200, { "Content-Length": "2" });
    res.end("ok");
  });
  req.on("close", () => console.log(`${label} close`, req.complete));
}

function exercise(label: string, server: Server, done: () => void): void {
  server.listen(0, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const socket = connect(port, "127.0.0.1");
    let seen = "";
    socket.on("connect", () => {
      socket.write(
        `POST /${label}/dup?x=1 HTTP/1.1\r\n` +
          "Host: localhost\r\n" +
          "X-Dup: one\r\n" +
          "X-Dup: two\r\n" +
          "Cookie: a=1\r\n" +
          "Cookie: b=2\r\n" +
          "Authorization: A\r\n" +
          "Authorization: B\r\n" +
          "Transfer-Encoding: chunked\r\n" +
          "Trailer: X-Trail\r\n" +
          "\r\n" +
          "2\r\nhi\r\n" +
          "0\r\n" +
          "X-Trail: t1\r\n" +
          "X-Trail: t2\r\n" +
          "\r\n",
      );
    });
    socket.on("data", (chunk: Buffer) => {
      seen += chunk.toString("latin1");
    });
    socket.on("end", () => {
      console.log(label, "reply", seen.includes("200 OK"));
      server.close(() => {
        console.log(label, "closed");
        done();
      });
    });
  });
}

exercise("default", createServer(handle), () => {
  exercise("join", createServer({ joinDuplicateHeaders: true }, handle), () => {
    exercise("keep", createServer({ joinDuplicateHeaders: false }, handle), () => {});
  });
});
