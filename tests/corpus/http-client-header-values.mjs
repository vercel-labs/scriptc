// ClientRequest's header surface takes Node's value forms: strings, numbers,
// null and arrays (one wire line per element), keeps the raw value for
// getHeader/getHeaders, and appendHeader grows an array.
import { createServer, request } from "node:http";

const server = createServer((req, res) => {
  const names = ["x-num", "x-list", "x-listnum", "x-nil", "x-replace", "x-fresh-append", "x-drop", "cookie"];
  for (const name of names) console.log("server", name, JSON.stringify(req.headers[name] ?? "<absent>"));
  const raw = req.rawHeaders.filter((value, i) => (i % 2 === 1 ? true : /^(?:x-|Cookie$)/.test(value)));
  console.log("server raw", JSON.stringify(raw.map((value) => value.replace(/^127\.0\.0\.1:\d+$/, "host"))));
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const req = request({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
    res.resume();
    res.on("end", () => server.close(() => console.log("closed")));
  });
  req.setHeader("x-num", 42);
  req.setHeader("x-list", ["a", "b"]);
  const mixed = /** @type {any} */ ([1, 2]);
  req.setHeader("x-listnum", mixed);
  req.setHeader("x-nil", null);
  req.setHeader("Cookie", ["a=1", "b=2"]);
  req.setHeader("x-replace", "old");
  req.setHeader("x-replace", "new");
  req.appendHeader("x-replace", ["two", "three"]);
  req.appendHeader("x-fresh-append", "one");
  req.setHeader("x-drop", "gone");
  req.removeHeader("x-drop");
  try {
    req.setHeader("x-bad", undefined);
  } catch (err) {
    console.log("undefined value", err.code);
  }
  console.log("has", req.hasHeader("x-num"), req.hasHeader("x-drop"));
  console.log("names", JSON.stringify(req.getHeaderNames()));
  console.log("raw names", JSON.stringify(req.getRawHeaderNames()));
  const all = req.getHeaders();
  delete all.host;
  console.log("headers", JSON.stringify(all));
  req.end();
});
