// createServer({ rejectNonStandardBodyWrites: true }): body writes on a
// 204/304 response or a HEAD request throw ERR_HTTP_BODY_NOT_ALLOWED after
// the implicit head is stored (headersSent true), while end() with no data
// still completes the response.
import { createServer, request } from "node:http";

const server = createServer({ rejectNonStandardBodyWrites: true }, (req, res) => {
  const attempt = (label: string, fn: () => unknown): void => {
    try {
      fn();
      console.log(label, "ok", res.headersSent, res.writableEnded);
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      console.log(label, e.name, e.code, e.message, res.headersSent, res.writableEnded);
    }
  };
  if (req.url === "/204") {
    res.writeHead(204);
    attempt("204 write empty", () => res.write(""));
    attempt("204 write", () => res.write("x"));
    attempt("204 end", () => res.end());
    return;
  }
  if (req.url === "/304") {
    res.statusCode = 304;
    attempt("304 end data", () => res.end("x"));
    attempt("304 end", () => res.end());
    return;
  }
  if (req.url === "/304write") {
    res.writeHead(304);
    attempt("304 write", () => res.write("x"));
    attempt("304 end", () => res.end());
    return;
  }
  if (req.url === "/head") {
    attempt("head end data", () => res.end("x"));
    attempt("head end", () => res.end());
    return;
  }
  res.end("ok");
});

server.listen(0, () => {
  const port = server.address().port;
  const paths: [string, string][] = [
    ["/204", "GET"],
    ["/304", "GET"],
    ["/304write", "GET"],
    ["/head", "HEAD"],
    ["/get", "GET"],
  ];
  const visit = (index: number): void => {
    if (index === paths.length) {
      server.close(() => console.log("closed"));
      return;
    }
    const [path, method] = paths[index]!;
    const outbound = request({ port, path, method }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      response.on("end", () => {
        console.log("reply", method, path, response.statusCode, JSON.stringify(body));
        visit(index + 1);
      });
    });
    outbound.on("error", (error) => console.log("client error", error.message));
    outbound.end();
  };
  visit(0);
});
