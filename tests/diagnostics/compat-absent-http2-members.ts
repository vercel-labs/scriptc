// node:http2 members with no native implementation: each use is refused
// at build time.
import * as http2 from "node:http2";

const server = http2.createServer();
server.setTimeout(1000);
server.on("stream", (stream) => {
  stream.sendTrailers({ "x-trailer": "1" });
  stream.additionalHeaders({ ":status": 103 });
  stream.respondWithFile("/tmp/file");
  stream.respondWithFD(0);
  stream.pushStream({ ":path": "/pushed" }, () => {});
  stream.priority({ weight: 1 });
  stream.setTimeout(1000);
  console.log(stream.pushAllowed, stream.state, stream.sentHeaders);
});
const client = http2.connect("http://127.0.0.1:1");
client.setTimeout(1000);
client.unref();
client.goaway(0);
client.on("timeout", () => {});
const request = client.request({ ":path": "/" });
request.on("push", () => {});
request.on("headers", () => {});
request.on("ready", () => {});
