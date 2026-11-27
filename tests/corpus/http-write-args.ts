// write/end with an encoding and a flush callback on both messages: the
// encoding applies to a string chunk (a Buffer carries its own bytes), the
// callback runs once the chunk has been flushed, and an unknown encoding is
// Node's catchable error before anything is written.
import * as http from "node:http";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const server = http.createServer((req, res) => {
  if (req.url === "/write-enc") {
    console.log("write-enc accepted", res.write("é", "latin1"));
  } else if (req.url === "/write-cb") {
    console.log("write-cb", res.write("x", () => console.log("write callback")));
  } else if (req.url === "/write-enc-cb") {
    res.write("é", "utf8", () => console.log("utf8 callback"));
  } else if (req.url === "/end-enc") {
    res.end("é", "latin1");
    return;
  } else if (req.url === "/end-enc-cb") {
    res.end("ok", "utf8", () => console.log("end callback"));
    return;
  } else if (req.url === "/unknown") {
    try {
      res.write("x", "bogus");
      console.log("unknown accepted");
    } catch (err) {
      console.log("unknown", (err as { code?: string }).code);
    }
  } else if (req.url === "/buffer-enc") {
    // a Buffer carries its own bytes: the encoding is ignored
    console.log("buffer-enc", res.write(Buffer.from([0x61]), "latin1"));
  } else if (req.url === "/echo") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      console.log("server body", hex(Buffer.concat(chunks)));
      res.end();
    });
    return;
  }
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const paths = [
    "/write-enc",
    "/write-cb",
    "/write-enc-cb",
    "/end-enc",
    "/end-enc-cb",
    "/unknown",
    "/buffer-enc",
  ];
  const pathAt = (i: number): string => paths[i] ?? "/other";
  const clientWrites = (): void => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/echo", method: "POST" },
      (res) => {
        res.resume();
        res.on("end", () => {
          console.log("client latin1", res.statusCode);
          server.close();
        });
      },
    );
    req.write("é", "latin1", () => console.log("client write callback"));
    req.end("ê", "latin1", () => console.log("client end callback"));
  };
  const run = (i: number): void => {
    if (i >= paths.length) {
      clientWrites();
      return;
    }
    const req = http.request({ host: "127.0.0.1", port, path: pathAt(i) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        console.log(pathAt(i), res.statusCode, hex(Buffer.concat(chunks)));
        run(i + 1);
      });
    });
    req.on("error", (err) => {
      console.log(pathAt(i), "error", (err as { code?: string }).code);
      run(i + 1);
    });
    req.end();
  };
  run(0);
});
