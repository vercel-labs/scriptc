// response.setHeaders(headers): one setHeader per entry of a Headers or a
// Map, the set-cookie entries collected into one array, and Node's errors
// for a head already sent, a bad header name and a value of another type.
import * as http from "node:http";

function describe(error: unknown): string {
  const e = error as { name: string; code?: string; message: string };
  return `${e.name} ${e.code} ${e.message}`;
}

const server = http.createServer((req, res) => {
  if (req.url === "/headers") {
    const headers = new Headers({ "X-B": "2", "x-a": "1", "Content-Type": "text/plain" });
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    headers.append("x-a", "again");
    res.setHeaders(headers);
    console.log(req.url, JSON.stringify(res.getHeaderNames()), String(res.getHeader("set-cookie")));
    console.log(req.url, res.getHeader("x-a"), res.hasHeader("x-b"), res.headersSent);
    res.end("headers");
  } else if (req.url === "/map") {
    res.setHeader("x-kept", "yes");
    res.setHeader("x-replaced", "old");
    const headers = new Map<string, string>([
      ["X-Replaced", "new"],
      ["x-first", "1"],
      ["set-cookie", "only=1"],
    ]);
    res.setHeaders(headers);
    console.log(req.url, JSON.stringify(res.getHeaders()));
    res.end("map");
  } else if (req.url === "/values") {
    const headers = new Map<string, string | number | string[]>();
    headers.set("content-length", 6);
    headers.set("x-list", ["a", "b"]);
    headers.set("set-cookie", ["c=3", "d=4"]);
    headers.set("Set-Cookie", "e=5");
    res.setHeaders(headers);
    console.log(req.url, JSON.stringify(res.getHeaders()));
    res.end("values");
  } else if (req.url === "/empty") {
    res.setHeaders(new Map<string, string>());
    res.setHeaders(new Headers());
    console.log(req.url, JSON.stringify(res.getHeaderNames()));
    res.end("empty");
  } else if (req.url === "/bad-name") {
    try {
      res.setHeaders(new Map<string, string>([["x-ok", "1"], ["bad name", "2"], ["x-never", "3"]]));
    } catch (error) {
      console.log(req.url, describe(error));
    }
    console.log(req.url, JSON.stringify(res.getHeaderNames()));
    try {
      res.setHeaders(new Map<string, string>([["x-value", "line\nbreak"]]));
    } catch (error) {
      console.log(req.url, describe(error));
    }
    res.end("bad-name");
  } else if (req.url === "/wrong-type") {
    const values: unknown[] = [{ a: 1 }, ["x", "y"], "text", 5, null, undefined, new Set(["a"])];
    for (const value of values) {
      try {
        res.setHeaders(value as any);
        console.log(req.url, "accepted");
      } catch (error) {
        console.log(req.url, describe(error));
      }
    }
    res.end("wrong-type");
  } else {
    res.writeHead(200, { "content-type": "text/plain" });
    try {
      res.setHeaders(new Headers({ "x-late": "1" }));
    } catch (error) {
      console.log(req.url, describe(error));
    }
    res.write("sent");
    try {
      res.setHeaders(new Map<string, string>([["x-late", "1"]]));
    } catch (error) {
      console.log(req.url, describe(error));
    }
    res.end();
  }
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  for (const path of ["/headers", "/map", "/values", "/empty", "/bad-name", "/wrong-type", "/sent"]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    const seen: string[] = [];
    response.headers.forEach((value, name) => {
      if (name !== "date") seen.push(`${name}: ${value}`);
    });
    console.log(path, response.status, JSON.stringify(seen), JSON.stringify(response.headers.getSetCookie()));
    console.log(path, JSON.stringify(await response.text()));
  }
  server.close();
});
