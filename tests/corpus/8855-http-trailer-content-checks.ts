// addTrailers checks each trailer as Node does, on a response and on a
// request: the name is a token (ERR_INVALID_HTTP_TOKEN, "Trailer name"),
// and the value holds only header content characters (ERR_INVALID_CHAR,
// "trailer content"), which excludes control characters, DEL and every
// character above U+00FF. Only the valid trailers are sent.
import * as http from "node:http";

function check(label: string, add: () => void): void {
  try {
    add();
    console.log(label, "accepted");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, "threw", e.name, e.code, JSON.stringify(e.message));
  }
}

// A name longer than any fixed message buffer, printed whole.
const long: Record<string, string> = {};
long["x " + "n".repeat(200)] = "v";

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    console.log("request trailers", JSON.stringify(req.trailers));
    res.writeHead(200, { trailer: "x-sum" });
    res.write("body");
    check("response CR LF", () => res.addTrailers({ "x-sum": "v\r\nx-injected: 1" }));
    check("response NUL", () => res.addTrailers({ "x-sum": "a\u0000b" }));
    check("response DEL", () => res.addTrailers({ "x-sum": "a\u007fb" }));
    check("response above U+00FF", () => res.addTrailers({ "x-sum": "☃" }));
    check("response surrogate pair", () => res.addTrailers({ "x-sum": "\u{1f600}" }));
    check("response name space", () => res.addTrailers({ "x sum": "v" }));
    check("response name empty", () => res.addTrailers({ "": "v" }));
    check("response long name", () => res.addTrailers(long));
    check("response tab", () => res.addTrailers({ "x-sum": "a\tb" }));
    res.end();
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request({ host: "127.0.0.1", port, method: "POST", headers: { trailer: "x-check" } }, (res) => {
    res.resume();
    res.on("end", () => {
      console.log("response trailers", JSON.stringify(res.trailers));
      server.close();
    });
  });
  req.write("body");
  check("request CR LF", () => req.addTrailers({ "x-check": "v\r\nx-injected: 2" }));
  check("request above U+00FF", () => req.addTrailers({ "x-check": "☃" }));
  check("request DEL", () => req.addTrailers({ "x-check": "a\u007fb" }));
  check("request name colon", () => req.addTrailers({ "x:check": "v" }));
  check("request plain", () => req.addTrailers({ "x-check": "fine" }));
  req.end();
});
