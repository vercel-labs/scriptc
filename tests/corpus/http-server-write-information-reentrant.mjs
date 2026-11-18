// writeInformation validates and serializes header values whose coercion can
// run program code. A value that removes its own header entry (or the tuple
// holding it) must still serialize the value it was given, without the
// runtime reading a freed header entry.
import { createServer } from "node:http";
import { connect } from "node:net";

const server = createServer((req, res) => {
  res.sendDate = false;
  if (req.url === "/object") {
    const headers = {};
    headers["X-A"] = {
      toString() {
        delete headers["X-A"];
        return "one";
      },
    };
    res.writeInformation(110, headers);
  } else {
    const headers = [
      [
        "X-A",
        {
          toString() {
            headers.length = 0;
            return "two";
          },
        },
      ],
    ];
    res.writeInformation(110, headers);
  }
  res.end("ok");
});

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const paths = ["/object", "/tuple"];
  const visit = (index) => {
    if (index === paths.length) {
      server.close(() => console.log("closed"));
      return;
    }
    const path = paths[index];
    const socket = connect(port, "127.0.0.1");
    let wire = "";
    socket.on("connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: l\r\nConnection: close\r\n\r\n`));
    socket.on("data", (chunk) => {
      wire += chunk.toString("latin1");
    });
    socket.on("close", () => {
      const heads = wire.split("\r\n\r\n");
      for (let i = 0; i < heads.length - 1; i++) console.log(path, "head", JSON.stringify(heads[i].split("\r\n")));
      console.log(path, "body", JSON.stringify(heads[heads.length - 1]));
      visit(index + 1);
    });
  };
  visit(0);
});
