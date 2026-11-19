// writeInformation headers imported from a TypeScript module: a
// Record<string, string> with the callback form, and the wider
// OutgoingHttpHeaders value (an array and a number) without one; Node joins
// an array value with commas on one informational line.
import { createServer } from "node:http";
import { connect } from "node:net";
import { mixedHeaders, plainHeaders } from "./headers.ts";

let callbacks = 0;
const paths = ["/callback", "/wider"];

const server = createServer((req, res) => {
  res.sendDate = false;
  if (req.url === "/callback") {
    res.writeInformation(110, plainHeaders, () => {
      callbacks += 1;
    });
  } else {
    res.writeInformation(103, mixedHeaders);
  }
  res.writeHead(200, { "Content-Length": "2" });
  res.end("ok");
});

server.listen(0, () => {
  const port = server.address().port;
  const visit = (index) => {
    if (index === paths.length) {
      server.close(() => console.log("callbacks", callbacks));
      return;
    }
    const path = paths[index];
    const socket = connect(port, "127.0.0.1");
    let wire = "";
    socket.on("connect", () =>
      socket.write(`GET ${path} HTTP/1.1\r\nHost: l\r\nConnection: close\r\n\r\n`),
    );
    socket.on("data", (chunk) => {
      wire += chunk.toString("latin1");
    });
    socket.on("close", () => {
      const heads = wire.split("\r\n\r\n");
      for (let i = 0; i < heads.length - 1; i++)
        console.log(path, "head", JSON.stringify(heads[i].split("\r\n")));
      visit(index + 1);
    });
  };
  visit(0);
});
