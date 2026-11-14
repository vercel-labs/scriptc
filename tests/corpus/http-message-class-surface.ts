// The documented members of http.IncomingMessage, http.ServerResponse and
// http.ClientRequest are all reachable with Node's values: the version
// split, the header views, the socket views, the lifecycle flags and the
// event names.
import * as http from "node:http";

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  console.log("req version", req.httpVersion, req.httpVersionMajor, req.httpVersionMinor);
  console.log("req line", req.method, req.url, "aborted", req.aborted, "complete", req.complete);
  const rawNames: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) rawNames.push(req.rawHeaders[i]!);
  console.log("req headers", req.headers.host !== undefined, req.headersDistinct["host"] !== undefined);
  console.log("req raw", req.rawHeaders.length, rawNames.join(","));
  console.log(
    "req trailers",
    JSON.stringify(req.trailers),
    JSON.stringify(req.rawTrailers),
    JSON.stringify(req.trailersDistinct),
  );
  console.log("req socket", req.socket !== null, req.connection === req.socket, "destroyed", req.destroyed);
  console.log("req signal", typeof req.signal, req.signal.aborted);
  req.setTimeout(0);
  console.log("res req identity", res.req === req);
  console.log("res state", res.headersSent, res.writableEnded, res.writableFinished, res.finished, res.destroyed);
  console.log("res socket", res.socket !== null, res.connection === res.socket);
  console.log("res head props", res.statusCode, res.statusMessage, res.sendDate, res.strictContentLength);
  res.sendDate = false;
  res.setHeader("X-One", "1");
  res.appendHeader("X-One", "2");
  console.log(
    "res header",
    JSON.stringify(res.getHeader("X-One") ?? null),
    res.hasHeader("x-one"),
    res.getHeaderNames().length,
    JSON.stringify(res.getHeaders()["x-one"] ?? null),
  );
  res.removeHeader("X-One");
  console.log("res after remove", res.hasHeader("X-One"), res.getHeaderNames().length);
  res.setHeader("X-Two", 7);
  res.writeHead(200, "Fine", { "X-Three": ["a", "b"] });
  console.log("res sent", res.headersSent, res.writableEnded, JSON.stringify(res.getHeaders()));
  res.cork();
  res.write("cor");
  console.log("res cork", res.writableCorked, res.writableLength > 0);
  res.uncork();
  res.addTrailers({ "X-Trailer": "t" });
  res.on("finish", () => console.log("res finish", res.writableEnded, res.writableFinished, res.finished));
  res.on("close", () => console.log("res close", res.destroyed));
  res.end("ked");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request({ host: "127.0.0.1", port, path: "/p", method: "POST" });
  console.log("creq static", req.method, req.path, req.host, req.protocol, req.maxHeadersCount);
  console.log(
    "creq state",
    req.destroyed,
    req.aborted,
    req.finished,
    req.headersSent,
    req.writableEnded,
    req.writableFinished,
    req.reusedSocket,
  );
  console.log("creq socket", req.connection === req.socket);
  req.setNoDelay(true);
  req.setSocketKeepAlive(false);
  req.setHeader("X-Req", "r");
  console.log(
    "creq header",
    JSON.stringify(req.getHeader("X-Req") ?? null),
    req.hasHeader("x-req"),
    JSON.stringify(req.getHeaderNames()),
    JSON.stringify(req.getRawHeaderNames()),
  );
  req.on("finish", () => console.log("creq finish", req.writableFinished, req.finished));
  req.on("close", () => console.log("creq close"));
  req.on("response", (res: http.IncomingMessage) => {
    console.log(
      "cres line",
      res.statusCode,
      res.statusMessage,
      res.httpVersion,
      res.httpVersionMajor,
      res.httpVersionMinor,
    );
    console.log("cres flags", res.aborted, res.complete, res.destroyed, JSON.stringify(res.url));
    console.log(
      "cres headers",
      res.headers["x-three"] !== undefined,
      JSON.stringify(res.headersDistinct["x-three"] ?? null),
      JSON.stringify(res.rawHeaders),
    );
    console.log("cres socket", res.socket !== null, res.connection === res.socket);
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => console.log("cres data", chunk));
    res.on("end", () => {
      console.log("cres end", res.complete, res.aborted, res.destroyed);
      console.log(
        "cres trailers",
        JSON.stringify(res.trailers),
        JSON.stringify(res.rawTrailers),
        JSON.stringify(res.trailersDistinct),
      );
    });
    res.on("close", () => {
      console.log("cres close", res.destroyed);
      server.close(() => console.log("closed"));
    });
  });
  req.end("body");
});
