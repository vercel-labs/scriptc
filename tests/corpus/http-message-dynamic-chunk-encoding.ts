// A chunk whose type is a union of string and Buffer (the checked-dynamic
// chunk form) with the encoding argument: write/end still encode a string
// arm and ignore the encoding for a Buffer arm, on ServerResponse and
// ClientRequest alike, with and without a callback. An unknown encoding is
// ERR_UNKNOWN_ENCODING before anything is buffered.
import * as http from "node:http";

type Chunk = string | Buffer;
function chunk(asText: boolean): Chunk {
  return asText ? "aGVsbG8=" : Buffer.from("hi");
}

const server = http.createServer((req, res) => {
  if (req.url === "/dyn") {
    const answered = res.write(chunk(true), "base64");
    console.log("server write text", answered);
    console.log("server write bytes", res.write(chunk(false), "hex", () => console.log("server write cb")));
    res.end(chunk(true), "base64");
    return;
  }
  const body: Buffer[] = [];
  req.on("data", (part: Buffer) => body.push(part));
  req.on("end", () => {
    console.log("server body", JSON.stringify(Buffer.concat(body).toString("latin1")));
    res.end("ok");
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const post = http.request(
    { host: "127.0.0.1", port, method: "POST", path: "/dyn" },
    (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (part: string) => (text += part));
      res.on("end", () => {
        console.log("client body", JSON.stringify(text));
        const echo = http.request(
          { host: "127.0.0.1", port, method: "POST", path: "/echo" },
          (inner) => {
            inner.resume();
            inner.on("end", () => server.close(() => console.log("closed")));
          },
        );
        console.log("client write text", echo.write(chunk(true), "base64", () => console.log("write cb text")));
        console.log("client write bytes", echo.write(chunk(false), "hex"));
        try {
          echo.write(chunk(true), "nope");
          console.log("unknown encoding accepted");
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          console.log("unknown encoding", code, (err as Error).message);
        }
        echo.end(chunk(true), "utf8", () => console.log("end cb"));
      });
    },
  );
  post.end();
});
