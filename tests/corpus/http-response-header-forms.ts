// ServerResponse's header surface: setHeader/getHeader/hasHeader/
// removeHeader are case-insensitive and chain, a numeric value reads back
// as the number and an array as itself, and a name that is not a string
// throws Node's ERR_INVALID_ARG_TYPE. writeHead accepts the documented
// forms (status only, status with a message, status with a headers record,
// status with both, and status with a flat name/value array), and its
// headers merge over the ones already set.
import * as http from "node:http";

function label(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return typeof v + ":" + String(v);
}

const server = http.createServer((req, res) => {
  const url = req.url;
  if (url === "/bookkeeping") {
    res.setHeader("x-num", 5);
    res.setHeader("x-str", "s");
    res.setHeader("x-arr", ["a", "b"]);
    res.setHeader("X-Str", "over");
    console.log("read", res.getHeader("x-num"), res.getHeader("x-str"), res.getHeader("x-arr"));
    console.log("has", res.hasHeader("X-NUM"), res.hasHeader("nope"));
    res.removeHeader("X-Num");
    console.log("gone", res.getHeader("x-num"), res.hasHeader("x-num"), res.getHeaderNames().length);
    const chained = res.setHeader("a", "1").setHeader("b", "2");
    console.log("chain", chained === res, res.getHeader("a"));
    res.end("bookkeeping");
  } else if (url === "/names") {
    res.setHeader("x-c", "3");
    const bads: unknown[] = [42, null, undefined, {}, ["x"]];
    for (const bad of bads) {
      const name: any = bad;
      try {
        console.log("get", String(res.getHeader(name)));
      } catch (e) {
        console.log("get threw", (e as NodeJS.ErrnoException).code, (e as Error).message);
      }
      try {
        console.log("has", res.hasHeader(name));
      } catch (e) {
        console.log("has threw", (e as NodeJS.ErrnoException).code, (e as Error).message);
      }
      try {
        res.removeHeader(name);
        console.log("remove ok");
      } catch (e) {
        console.log("remove threw", (e as NodeJS.ErrnoException).code, (e as Error).message);
      }
    }
    console.log("names", JSON.stringify(res.getHeaderNames()));
    res.end("names");
  } else if (url === "/head-status") {
    res.writeHead(201);
    res.end("head-status");
  } else if (url === "/head-message") {
    res.writeHead(202, "Fine By Me");
    res.end("head-message");
  } else if (url === "/head-object") {
    res.writeHead(203, { "x-a": "1", "x-n": 7 });
    res.end("head-object");
  } else if (url === "/head-both") {
    res.writeHead(204, "Msg Here", { "x-b": ["p", "q"] });
    res.end("head-both");
  } else if (url === "/head-array") {
    res.setHeader("x-c", "already");
    res.writeHead(205, ["x-c", "9", "x-d", "4"]);
    res.end("head-array");
  } else {
    res.end("other");
  }
});

function get(port: number, path: string): Promise<void> {
  return new Promise<void>((resolve) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => {
        const pick = (name: string): string => `${name}=${JSON.stringify(res.headers[name])}`;
        console.log(path, res.statusCode, JSON.stringify(res.statusMessage), pick("x-a"), pick("x-b"), pick("x-c"), pick("x-d"), pick("x-num"), pick("x-str"), pick("x-arr"), JSON.stringify(body));
        resolve();
      });
    });
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  const paths = ["/bookkeeping", "/names", "/head-status", "/head-message", "/head-object", "/head-both", "/head-array"];
  for (const p of paths) await get(port, p);
  server.close(() => console.log("closed"));
});
