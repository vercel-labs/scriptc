// HTTP/2 header lists are checked as Node checks them. A regular name that
// holds a space throws ERR_INVALID_HTTP_TOKEN from request() and respond()
// before anything is sent, so the call can be made again. A received field
// whose value holds a control character is malformed (RFC 9113 8.2.1) and is
// left out of the headers the application sees.
import * as http2 from "node:http2";

function check(label: string, send: () => unknown): boolean {
  try {
    send();
    console.log(label, "accepted");
    return true;
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, "threw", e.name, e.code, JSON.stringify(e.message));
    return false;
  }
}

// The compatibility response checks a name in setHeader.
function compatibility(): void {
  const compat = http2.createServer((req, res) => {
    check("setHeader, name with a space", () => res.setHeader("x y", "v"));
    check("setHeader, empty name", () => res.setHeader("", "v"));
    res.setHeader("x-ok", "1");
    res.end("ok");
  });
  compat.listen(0, "127.0.0.1", () => {
    const port = (compat.address() as { port: number }).port;
    const session = http2.connect("http://127.0.0.1:" + port);
    const req = session.request({ ":path": "/compat" });
    req.on("response", (h) => console.log("response /compat", h[":status"], JSON.stringify(h["x-ok"] ?? null)));
    req.resume();
    req.on("close", () => {
      session.close();
      compat.close();
    });
    req.end();
  });
}

const server = http2.createServer();
server.on("stream", (stream, headers) => {
  console.log("server saw", headers[":path"], JSON.stringify(headers["x-v"] ?? null), JSON.stringify(headers["x-plain"] ?? null));
  const sent = check("respond, name with a space", () => stream.respond({ ":status": 200, "X Y": "v" }));
  if (!sent) stream.respond({ ":status": 200, "x-back": "v\r\nx-injected: 2", "x-plain": "kept" });
  stream.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const session = http2.connect("http://127.0.0.1:" + port);
  session.on("error", (e: NodeJS.ErrnoException) => console.log("session error", e.code));

  check("request, name with a space", () => session.request({ ":path": "/refused", "x y": "v" }));
  check("request, upper case name with a space", () => session.request({ ":path": "/refused", "X-Trace Id": "v" }));

  const values: [string, string][] = [
    ["/cr-lf", "v\r\nx-injected: 1"],
    ["/lf", "a\nb"],
    ["/del", "a\u007fb"],
    ["/tab", "a\tb"],
    ["/plain", "fine"],
  ];
  const next = (i: number): void => {
    if (i === values.length) {
      session.close();
      server.close();
      compatibility();
      return;
    }
    const [path, value] = values[i]!;
    const req = session.request({ ":path": path, "x-v": value, "x-plain": "kept" });
    req.on("response", (h) => {
      console.log("response", path, h[":status"], JSON.stringify(h["x-back"] ?? null), JSON.stringify(h["x-plain"] ?? null));
    });
    req.on("error", (e: NodeJS.ErrnoException) => console.log("stream error", path, e.code));
    req.resume();
    req.on("close", () => next(i + 1));
    req.end();
  };
  next(0);
});
