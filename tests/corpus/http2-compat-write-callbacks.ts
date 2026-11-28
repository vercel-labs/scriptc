// An HTTP/2 compatibility response's write callback runs after the frame is
// queued, so ending the response from the callback completes the stream.
import * as http2 from "node:http2";

const server = http2.createServer();
server.on("request", (req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.write("frame", () => {
    console.log("write callback");
    res.end("done", () => console.log("end callback"));
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const client = http2.connect(`http://127.0.0.1:${port}`);
  client.on("error", () => {});
  const stream = client.request({ ":path": "/" });
  let body = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => { body += chunk; });
  stream.on("end", () => {
    console.log("stream end", JSON.stringify(body));
    client.close();
    server.close();
  });
  stream.end();
});
