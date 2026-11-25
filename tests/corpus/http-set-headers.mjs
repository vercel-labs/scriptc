// The JavaScript twin of http-set-headers.ts: setHeaders called on a message
// held as an untyped value, through the runtime's member dispatch rather than
// the typed lowering, so the same entries must reach the head from either
// source.
import http from "node:http";

const server = http.createServer((request, response) => {
  if (request.url === "/map") {
    response.setHeaders(
      new Map([
        ["X-A", "1"],
        ["Set-Cookie", ["a=1", "b=2"]],
      ]),
    );
    console.log("names", JSON.stringify(response.getHeaderNames()));
    console.log("cookie", String(response.getHeader("set-cookie")));
    response.end("ok");
    return;
  }
  response.end("other");
});

const paths = ["/map"];
const next = (i) => {
  if (i >= paths.length) {
    server.close();
    return;
  }
  http.get({ host: "127.0.0.1", port: server.address().port, path: paths[i] }, (res) => {
    if (paths[i] === "/map") {
      console.log("header", res.headers["x-a"], String(res.headersDistinct["set-cookie"]));
    }
    res.resume();
    res.on("end", () => next(i + 1));
  });
};

server.listen(0, "127.0.0.1", () => next(0));
