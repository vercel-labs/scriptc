// OutgoingMessage.setHeaders(headers): a Map of names to values applied in
// order, set-cookie's values kept as one array, and Node's state and header
// checks. The ERR_INVALID_ARG_TYPE for a value that is not a Map or Headers
// needs an untyped source, where the call reaches the runtime with the value
// as it is: the JavaScript twin (http-set-headers.mjs) pins it.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  if (req.url === "/map") {
    res.setHeaders(new Map<string, string | string[]>([
      ["X-A", "1"],
      ["x-b", "2"],
      ["Set-Cookie", ["a=1", "b=2"] as string[]],
    ]));
    console.log("names", JSON.stringify(res.getHeaderNames()));
    console.log("a", res.getHeader("x-a"), "b", res.getHeader("x-b"));
    console.log("cookie", String(res.getHeader("set-cookie")));
    console.log("raw", JSON.stringify(res.getRawHeaderNames()));
    res.end("ok");
    return;
  }
  if (req.url === "/map-array") {
    // A Map<string, string[]> whose set-cookie values stay ONE array: the
    // wire carries one Set-Cookie line per cookie.
    res.setHeaders(new Map<string, string[]>([["set-cookie", ["a=1", "b=2"]]]));
    const value = res.getHeader("set-cookie") as string[];
    console.log("map-array", value.length, value[0], value[1]);
    res.end("ok");
    return;
  }
  if (req.url === "/numbers") {
    res.setHeaders(new Map<string, string | string[]>([["x-n", "5" as string]]));
    console.log("number", res.getHeader("x-n"));
    res.end();
    return;
  }
  if (req.url === "/after") {
    res.write("x");
    try {
      res.setHeaders(new Map([["x-a", "1"]]));
      console.log("after accepted");
    } catch (err) {
      console.log("after", (err as { code?: string }).code);
    }
    res.end();
    return;
  }
  if (req.url === "/badname") {
    try {
      res.setHeaders(new Map([["bad name", "1"]]));
      console.log("bad name accepted");
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.log("badname", e.code, e.message);
    }
    res.end();
    return;
  }
  res.end("other");
});

const paths = ["/map", "/map-array", "/numbers", "/after", "/badname"];
const pathAt = (i: number): string => paths[i] ?? "/other";
const next = (i: number): void => {
  if (i >= paths.length) {
    server.close();
    return;
  }
  http.get({ host: "127.0.0.1", port: server.address().port, path: pathAt(i) }, (res) => {
    if (pathAt(i) === "/map-array") {
      const seen = res.headersDistinct["set-cookie"] as string[];
      console.log("wire", seen.length, seen[0], seen[1]);
    }
    if (pathAt(i) === "/map") {
      console.log("response header", res.headers["x-a"], res.headers["x-b"], String(res.headersDistinct["set-cookie"]));
    }
    res.on("data", () => {});
    res.on("end", () => next(i + 1));
  });
};

server.listen(0, "127.0.0.1", () => next(0));
