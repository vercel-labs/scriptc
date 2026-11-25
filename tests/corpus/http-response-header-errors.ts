// ServerResponse header changes throw Node's errors: setHeader, appendHeader,
// removeHeader and writeHead after the head is committed throw
// ERR_HTTP_HEADERS_SENT; header names must be tokens (ERR_INVALID_HTTP_TOKEN),
// header values and the status message must be header content
// (ERR_INVALID_CHAR), and writeHead's status code must be within 100..999
// (ERR_HTTP_INVALID_STATUS_CODE). A failed call leaves the stored headers
// as they were.
import * as http from "node:http";

function attempt(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "ok");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, e.name, e.code, e.message);
  }
}

let round = 0;
const server = http.createServer((req, res) => {
  round++;
  if (round === 1) {
    attempt("bad name", () => res.setHeader("x bad", "1"));
    attempt("empty name", () => res.setHeader("", "1"));
    attempt("bad append name", () => res.appendHeader("x:y", "1"));
    attempt("bad value", () => res.setHeader("x-value", "a\nb"));
    attempt("bad number name", () => res.setHeader("x num", 7));
    attempt("bad list value", () => res.setHeader("x-list", ["ok", "b\rc"]));
    attempt("good", () => res.setHeader("X-Good", "fine"));
    attempt("latin1", () => res.setHeader("X-Latin", "café"));
    attempt("wide", () => res.setHeader("X-Wide", "Ā"));
    console.log("names", res.getHeaderNames().join(","));
    attempt("status 99", () => res.writeHead(99));
    attempt("status 1000", () => res.writeHead(1000));
    console.log("headersSent", res.headersSent);
    res.writeHead(200, { "X-Head": "w" });
    attempt("set after", () => res.setHeader("X-Late", "1"));
    attempt("append after", () => res.appendHeader("X-Late", "1"));
    attempt("remove after", () => res.removeHeader("X-Good"));
    attempt("writeHead after", () => res.writeHead(201));
    res.end("one");
  } else if (round === 2) {
    res.write("partial");
    attempt("set after write", () => res.setHeader("X-Late", "1"));
    res.end();
  } else {
    res.statusMessage = "bad\u0001reason";
    attempt("end with bad message", () => res.end("three"));
    res.statusMessage = "Fine";
    res.end("three");
  }
});

function get(port: number, then: () => void): void {
  http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
    const names: string[] = [];
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      if (res.rawHeaders[i] !== "Date") names.push(res.rawHeaders[i]!);
    }
    console.log("response", res.statusCode, res.statusMessage, names.join(","));
    res.resume();
    res.on("end", then);
  });
}

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  get(port, () => get(port, () => get(port, () => server.close())));
});
