// node:http2 members with no native implementation: each use is refused
// at build time.
import * as http2 from "node:http2";

const server = http2.createServer();
server.setTimeout(1000);
server.on("stream", (stream) => {
  stream.pushStream({ ":path": "/pushed" }, () => {});
  console.log(stream.pushAllowed, stream.state, stream.sentHeaders);
});
const client = http2.connect("http://127.0.0.1:1");
client.setTimeout(1000);
client.unref();
client.goaway(0);
client.on("timeout", () => {});
const request = client.request({ ":path": "/" });
request.on("push", () => {});
