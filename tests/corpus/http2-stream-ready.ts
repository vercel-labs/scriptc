// node:http2 'ready': a client request made before the session connects is
// initialized when the session does, so a listener registered on the
// returned stream hears 'ready' after 'connect'; a server stream is handed
// over already ready, so a listener registered in its handler never fires.
// Destroying one pending request from its ready callback must not skip the
// next request's ready. The two ends race, so the recorded lines are
// sorted.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

async function first(): Promise<void> {
  await new Promise<void>((resolve) => {
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
          server.close(() => resolve());
        });
      });
      request.end();
    });
  });
}

async function second(): Promise<void> {
  await new Promise<void>((resolve) => {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      stream.respond({ ":status": 200 });
      stream.end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const firstRequest = client.request({ ":path": "/1" });
      const secondRequest = client.request({ ":path": "/2" });
      firstRequest.on("ready", () => {
        lines.push("first ready, destroyed");
        firstRequest.destroy();
      });
      secondRequest.on("ready", () => lines.push("second ready"));
      secondRequest.resume();
      secondRequest.on("end", () => {
        client.close(() => server.close(() => resolve()));
      });
      firstRequest.end();
      secondRequest.end();
    });
  });
}

void (async () => {
  await first();
  await second();
  for (const line of lines.sort()) console.log(line);
})();
