// ServerResponse.setHeaders: a Map or a Headers object goes through
// setHeader in iteration order, set-cookie's values are kept as one array,
// a number value stays a number, and the call answers the response so it
// chains into writeHead/end. Invalid entries throw Node's codes, a sent head
// throws ERR_HTTP_HEADERS_SENT, and writableLength reports the bytes the
// response still holds.
import * as http from "node:http";

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  const path = req.url;
  if (path === "/map") {
    res.setHeaders(new Map<string, string>([["x-one", "1"], ["set-cookie", "a=1"]]));
    console.log("map", res.getHeader("x-one"), res.getHeader("set-cookie"));
    res.end("map");
    return;
  }
  if (path === "/headers") {
    const headers = new Headers();
    headers.append("x-one", "1");
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    res.setHeaders(headers);
    console.log("headers", res.getHeader("x-one"), res.getHeader("set-cookie"));
    res.end("headers");
    return;
  }
  if (path === "/numbers") {
    res.setHeaders(
      new Map<string, number | string | readonly string[]>([
        ["x-count", 42],
        ["x-list", ["a", "b"]],
      ]),
    );
    console.log("numbers", res.getHeader("x-count"), res.getHeader("x-list"));
    res.end("numbers");
    return;
  }
  if (path === "/arrow") {
    // a concise arrow body hands the response on to its caller
    const withHeaders = (response: http.ServerResponse) =>
      response.setHeaders(new Map<string, string>([["x-arrow", "yes"]]));
    const chained = withHeaders(res);
    chained.writeHead(202, "arrow").end("arrow");
    return;
  }
  if (path === "/chain") {
    res
      .setHeaders(new Map<string, string>([["x-chain", "yes"]]))
      .writeHead(201, "made")
      .end("chain");
    return;
  }
  if (path === "/bad-name") {
    try {
      res.setHeaders(new Map<string, string>([["x-ok", "1"], ["bad name", "2"]]));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.log("bad-name", err.code, err.message);
    }
    console.log("kept", res.getHeader("x-ok"));
    res.end("bad-name");
    return;
  }
  if (path === "/bad-value") {
    try {
      res.setHeaders(new Map<string, string>([["x-ok", "1"], ["x-bad", "a\nb"]]));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.log("bad-value", err.code, err.message);
    }
    res.end("bad-value");
    return;
  }
  if (path === "/sent") {
    res.writeHead(200);
    try {
      res.setHeaders(new Map<string, string>([["x-late", "1"]]));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.log("sent", err.code, err.message);
    }
    res.end();
    return;
  }
  if (path === "/lengths") {
    console.log("length start", res.writableLength);
    res.writeHead(200, "fine");
    res.write("hello");
    console.log("length after write", res.writableLength);
    res.end("!");
    console.log("length after end", res.writableLength);
    return;
  }
  res.end("plain");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const paths = [
    "/map",
    "/headers",
    "/numbers",
    "/chain",
    "/arrow",
    "/bad-name",
    "/bad-value",
    "/sent",
    "/lengths",
  ];
  const next = (index: number) => {
    if (index === paths.length) {
      server.close();
      return;
    }
    const path = paths[index]!;
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        console.log(path, res.statusCode, res.statusMessage, res.headers["x-one"], res.headers["x-count"], body);
        next(index + 1);
      });
    });
  };
  next(0);
});
