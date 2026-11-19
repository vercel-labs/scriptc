// node:http2 'ready': a client request made before the session connects is
// initialized when the session does, so a listener registered on the
// returned stream hears 'ready' after 'connect'; a server stream is handed
// over already ready, so a listener registered in its handler never fires.
// The two ends race, so the recorded lines are sorted.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream) => {
  stream.on("ready", () => lines.push("server ready"));
  stream.respond({ ":status": 200 });
  stream.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  // The request is created before the dial completes.
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("connect", () => lines.push("client connect"));
  const request = client.request({ ":path": "/" });
  request.on("ready", () => lines.push(`client ready id ${request.id}`));
  request.on("response", (headers) => lines.push(`response ${headers[":status"]}`));
  request.resume();
  request.on("end", () => {
    client.close(() => {
      server.close(() => {
        for (const line of lines.sort()) console.log(line);
      });
    });
  });
  request.end();
});
