// ServerResponse header writes and reads: setHeader/appendHeader/setHeaders/getHeader*
// value kinds and order, removeHeader, writeHead's statusMessage and flat/tuple
// header arrays, the ERR_HTTP_HEADERS_SENT / ERR_INVALID_HTTP_TOKEN /
// ERR_HTTP_INVALID_HEADER_VALUE / ERR_INVALID_CHAR ladders, and the
// statusCode/statusMessage/sendDate properties on the wire.
import { createServer, request } from "node:http";

function show(label: string, value: unknown): void {
  console.log(label, JSON.stringify(value));
}

const server = createServer((req, res) => {
  const path = req.url;
  // The Date header would make these runs differ; the default is checked
  // as a boolean on /date.
  res.sendDate = false;
  const attempt = (label: string, fn: () => unknown): void => {
    try {
      fn();
      console.log(label, "ok");
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      console.log(label, e.name, e.code, e.message);
    }
  };
  if (path === "/set") {
    res.setHeader("X-Str", "one");
    res.setHeader("X-Num", 42);
    res.setHeader("X-Arr", ["a", "b"]);
    res.appendHeader("X-Arr", "c");
    res.setHeaders(new Map<string, string | string[]>([["X-One", "1"], ["x-two", "2, 3"]]));
    show("headers", res.getHeaders());
    show("names", res.getHeaderNames());
    show("raw", res.getRawHeaderNames());
    show("get start", res.getHeader("x-str"));
    show("get num", res.getHeader("X-Num"));
    show("get arr", res.getHeader("x-arr"));
    show("has", [res.hasHeader("X-Str"), res.hasHeader("nope")]);
    res.removeHeader("X-Str");
    show("after remove", res.getHeader("x-str"));
    attempt("bad name", () => res.setHeader("Bad Name", "v"));
    attempt("undefined value", () => res.setHeader("X-Undef", undefined as unknown as string));
    attempt("invalid value", () => res.setHeader("X-Bad", "a\rb"));
    res.end("set");
    return;
  }
  if (path === "/writehead-array") {
    res.writeHead(201, "Made It", ["X-A", "1", "X-B", "2"]);
    res.end();
    return;
  }
  if (path === "/writehead-case-fast") {
    res.writeHead(203, { "X-A": "1", "x-a": "2", "Content-Length": "2" });
    res.end("ok");
    return;
  }
  if (path === "/writehead-case-progressive") {
    res.setHeader("X-A", "0");
    res.writeHead(203, { "X-A": "1", "x-a": "2", "Content-Length": "2" });
    res.end("ok");
    return;
  }
  if (path === "/writehead-array-value") {
    res.writeHead(203, { "X-A": ["1", "2"], "Content-Length": "2" });
    res.end("ok");
    return;
  }
  if (path === "/writehead-bad-object-value") {
    attempt("bad object value", () => res.writeHead(200, { "X-Bad": "a\rb" }));
    res.writeHead(200, { "Content-Length": "2" });
    res.end("ok");
    return;
  }
  if (path === "/writehead-bad-array-value") {
    attempt("bad array value", () => res.writeHead(200, { "X-Arr": ["ok", "a\rb"] }));
    res.writeHead(200, { "Content-Length": "2" });
    res.end("ok");
    return;
  }
  if (path === "/writehead-object") {
    res.writeHead(203, { "X-A": "1", "X-B": ["2", "3"] });
    res.end();
    return;
  }
  if (path === "/writehead-odds") {
    attempt("odd array", () => res.writeHead(200, ["X-A", "1", "X-B"]));
    attempt("invalid status", () => res.writeHead(99));
    attempt("too high", () => res.writeHead(1000));
    attempt("bad status message", () => res.writeHead(200, "Bad\rMessage"));
    attempt("bad header name", () => res.writeHead(200, { "Bad Name": "v" }));
    res.writeHead(200, "Fine");
    attempt("after sent", () => res.writeHead(201));
    attempt("set after sent", () => res.setHeader("X-Late", "v"));
    attempt("remove after sent", () => res.removeHeader("X-Str"));
    res.end("odds");
    return;
  }
  if (path === "/date") {
    res.sendDate = true;
    res.end("date");
    return;
  }
  if (path === "/status") {
    res.statusCode = 299;
    res.statusMessage = "Custom";
    res.sendDate = false;
    res.setHeader("Content-Type", "text/plain");
    res.end("status");
    return;
  }
  if (path === "/status-invalid") {
    res.statusCode = 99;
    attempt("end with bad status", () => res.end("x"));
    res.statusCode = 200;
    res.end("recovered");
    return;
  }
  res.end("default");
});

server.listen(0, () => {
  const port = server.address().port;
  const paths = [
    "/set",
    "/writehead-array",
    "/writehead-case-fast",
    "/writehead-case-progressive",
    "/writehead-array-value",
    "/writehead-bad-object-value",
    "/writehead-bad-array-value",
    "/writehead-object",
    "/writehead-odds",
    "/date",
    "/status",
    "/status-invalid",
    "/default",
  ];
  const visit = (index: number): void => {
    if (index === paths.length) {
      server.close(() => console.log("closed"));
      return;
    }
    const path = paths[index]!;
    const outbound = request({ port, path }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      response.on("end", () => {
        if (path === "/date") {
          show("reply /date", {
            status: response.statusCode,
            message: response.statusMessage,
            date: response.headers.date !== undefined,
            body,
          });
        } else {
          show(`reply ${path}`, {
            status: response.statusCode,
            message: response.statusMessage,
            headers: response.headers,
            raw: response.rawHeaders,
            body,
          });
        }
        visit(index + 1);
      });
    });
    outbound.on("error", (error) => console.log("client error", path, error.message));
    outbound.end();
  };
  visit(0);
});
