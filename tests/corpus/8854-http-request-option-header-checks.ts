// http.request checks the headers of its options before it takes a socket,
// as setHeader does: a name that is not a token throws
// ERR_INVALID_HTTP_TOKEN, a value outside header content throws
// ERR_INVALID_CHAR, and the Host header derived from the host option is
// checked the same way. Nothing reaches the server.
import * as http from "node:http";
import * as https from "node:https";

const served: string[] = [];
const server = http.createServer((req, res) => {
  served.push(`${req.method} ${req.url} x-ok=${String(req.headers["x-ok"])}`);
  res.end();
});

function attempt(label: string, make: () => http.ClientRequest): Promise<void> {
  return new Promise<void>((resolve) => {
    let req: http.ClientRequest;
    try {
      req = make();
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      console.log(label, "threw", e.name, e.code, JSON.stringify(e.message));
      resolve();
      return;
    }
    req.on("error", (e: NodeJS.ErrnoException) => {
      console.log(label, "error event", e.code);
      resolve();
    });
    req.on("response", (res) => {
      res.resume();
      res.on("end", () => {
        console.log(label, "response", res.statusCode);
        resolve();
      });
    });
    req.end();
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  const host = "127.0.0.1";
  const split = "v\r\nx-injected: 1";
  const record: Record<string, string> = { "x-record": split };
  const named: Record<string, string> = {};
  named["x-a\r\nx-injected: 2"] = "v";
  const agent = new http.Agent();

  // values
  await attempt("literal value CR LF", () => http.request({ host, port, path: "/1", headers: { "x-lit": split } }));
  await attempt("record value CR LF", () => http.request({ host, port, path: "/2", headers: record }));
  await attempt("value LF", () => http.request({ host, port, path: "/3", headers: { "x-lf": "a\nb" } }));
  await attempt("value CR", () => http.request({ host, port, path: "/4", headers: { "x-cr": "a\rb" } }));
  await attempt("value NUL", () => http.request({ host, port, path: "/5", headers: { "x-nul": "a\u0000b" } }));
  await attempt("value U+0001", () => http.request({ host, port, path: "/6", headers: { "x-ctl": "a\u0001b" } }));
  await attempt("value DEL", () => http.request({ host, port, path: "/7", headers: { "x-del": "a\u007fb" } }));
  await attempt("value above U+00FF", () => http.request({ host, port, path: "/8", headers: { "x-wide": "☃" } }));
  await attempt("host header value", () => http.request({ host, port, path: "/9", headers: { host: "h\r\nx-injected: 3" } }));

  // names
  await attempt("literal name space", () => http.request({ host, port, path: "/10", headers: { "x y": "v" } }));
  await attempt("record name CR LF", () => http.request({ host, port, path: "/11", headers: named }));
  await attempt("name empty", () => http.request({ host, port, path: "/12", headers: { "": "v" } }));
  await attempt("name colon", () => http.request({ host, port, path: "/13", headers: { "x:y": "v" } }));
  await attempt("name above U+007F", () => http.request({ host, port, path: "/14", headers: { "x-é": "v" } }));

  // the order of the checks: path, method, then the headers in their order,
  // each name before its value
  await attempt("path before headers", () => http.request({ host, port, path: "/1 5", headers: { "x-lit": split } }));
  await attempt("method before headers", () => http.request({ host, port, path: "/16", method: "G T", headers: { "x-lit": split } }));
  await attempt("first bad header", () => http.request({ host, port, path: "/17", headers: { "x-one": "ok", "x y": "a\nb", "x-three": "a\nb" } }));
  await attempt("value before a later name", () => http.request({ host, port, path: "/18", headers: { "x-one": "a\nb", "x y": "v" } }));

  // every form of the call
  await attempt("get", () => http.get({ host, port, path: "/19", headers: { "x-get": split } }));
  await attempt("agent: false", () => http.request({ host, port, path: "/20", agent: false, headers: { "x-lit": split } }));
  await attempt("an Agent", () => http.request({ host, port, path: "/21", agent, headers: { "x-lit": split } }));
  await attempt("url and options", () => http.request(`http://${host}:${port}/22`, { headers: { "x-url": split } }));
  await attempt("https value", () => https.request({ host, port, path: "/23", headers: { "x-tls": split } }));
  await attempt("https name", () => https.request({ host, port, path: "/24", headers: { "x y": "v" } }));
  await attempt("https get", () => https.get({ host, port, path: "/25", headers: { "x-tls": split } }));

  // the Host header Node derives from the host option
  const badHost = "h\r\nx-injected: 4";
  await attempt("host option", () => http.request({ host: badHost, port, path: "/26" }));
  await attempt("hostname option", () => http.request({ hostname: badHost, port, path: "/27" }));
  await attempt("host option above U+00FF", () => http.request({ host: "☃.invalid", port, path: "/28" }));
  await attempt("host option, an Agent", () => http.request({ host: badHost, port, path: "/29", agent }));
  await attempt("host option, agent: false", () => http.request({ host: badHost, port, path: "/30", agent: false }));
  await attempt("host option, socketPath", () => http.request({ socketPath: "/nonexistent/scriptc.sock", host: badHost, path: "/31" }));
  await attempt("host option, https", () => https.request({ host: badHost, port, path: "/32" }));

  // values Node accepts
  await attempt("tab", () => http.request({ host, port, path: "/ok-tab", headers: { "x-ok": "a\tb" } }));
  await attempt("empty", () => http.request({ host, port, path: "/ok-empty", headers: { "x-ok": "" } }));
  await attempt("number", () => http.request({ host, port, path: "/ok-number", headers: { "x-ok": 5 } }));
  await attempt("every token character", () =>
    http.request({ host, port, path: "/ok-token", headers: { "x-ok": "fine", "!#$%&'*+-.^_`|~09AZaz": "v" } }));

  agent.destroy();
  console.log("served:");
  for (const line of served) console.log(" ", JSON.stringify(line));
  server.close();
});
