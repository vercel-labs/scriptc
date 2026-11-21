// node:http2 members with no native implementation: each use is refused
// at build time.
import * as http2 from "node:http2";

const server = http2.createServer();
server.on("stream", (stream) => {
  stream.pushStream({ ":path": "/pushed" }, () => {});
  console.log(stream.state, stream.sentHeaders);
});
const client = http2.connect("http://127.0.0.1:1");
const request = client.request({ ":path": "/" });
request.on("push", () => {});
