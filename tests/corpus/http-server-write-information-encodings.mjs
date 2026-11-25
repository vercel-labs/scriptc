// writeInformation validates header values and then encodes them for the
// ASCII write the way Node does: obs-text Latin-1 characters become their
// single bytes (U+008A -> 0x8a, U+008D -> 0x8d), never CR/LF.
import { createServer } from "node:http";
import { connect } from "node:net";

const server = createServer((req, res) => {
  res.sendDate = false;
  if (req.url === "/info") {
    res.writeInformation(102, { "X-Obs": "\u008a\u008d", "X-Latin": "Á" });
    res.writeHead(200, { "Content-Length": "2" });
    res.end("ok");
    return;
  }
  res.end("other");
});

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const socket = connect(port, "127.0.0.1");
  const chunks = [];
  socket.on("connect", () => socket.write("GET /info HTTP/1.1\r\nHost: l\r\nConnection: close\r\n\r\n"));
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("close", () => {
    const wire = Buffer.concat(chunks).toString("latin1");
    const head = wire.split("\r\n\r\n")[0];
    console.log("head", Buffer.from(head, "latin1").toString("hex"));
    server.close(() => console.log("closed"));
  });
});
