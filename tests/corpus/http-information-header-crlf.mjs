// An informational head must not let validated text become CRLF, and a Link
// value carrying a CR/LF after its semicolon must be refused on both the
// typed and the untyped surface.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req, res) => {
  try {
    res.writeEarlyHints({ link: "<a.css>; rel=preload\r\nX-Injected: yes" });
    console.log("early hints accepted");
  } catch (e) {
    console.log("early hints", e && e.code);
  }
  try {
    res.writeInformation(103, { "x-latin": "\u008D" });
    console.log("information accepted");
  } catch (e) {
    console.log("information", e && e.code);
  }
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  let wire = "";
  const sock = net.connect(port, "127.0.0.1", () => {
    sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
  });
  sock.on("data", (c) => { wire += c.toString("latin1"); });
  sock.on("error", () => {});
  setTimeout(() => {
    const i = wire.indexOf("\r\n\r\n");
    const head = i >= 0 ? wire.slice(0, i) : wire;
    console.log("injected:", head.includes("X-Injected"));
    const at = wire.indexOf("x-latin: ");
    console.log("latin byte:", at >= 0 ? wire.charCodeAt(at + 9).toString(16) : "none");
    sock.destroy();
    server.close();
  }, 300);
});
