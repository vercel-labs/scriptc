// The checked-dynamic surface of a stream hears the same events as the
// typed one: an any-typed 'timeout' listener fires from a typed
// setTimeout, an any-typed setTimeout(ms, cb) registers its callback once,
// and an any-typed 'ready' listener hears the stream's establishment.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

function connect(server: http2.Http2Server): http2.ClientHttp2Session {
  return http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

// A: typed timer, dynamically registered handler
{
  const server = http2.createServer();
  server.on("stream", (stream) => {
    const dyn: any = stream;
    dyn.on("timeout", () => {
      lines.push("A timeout");
      stream.close();
    });
    stream.setTimeout(40);
    stream.respond({ ":status": 200 });
    stream.write("x");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const client = connect(server);
      const request = client.request({ ":path": "/" });
      request.on("error", () => {});
      request.resume();
      setTimeout(() => {
        client.destroy();
        server.close(() => resolve());
      }, 200);
    });
  });
}

// B: a dynamically typed timer with its callback
{
  const server = http2.createServer();
  server.on("stream", (stream) => {
    const dyn: any = stream;
    dyn.setTimeout(40, () => {
      lines.push("B callback");
      stream.close();
    });
    stream.respond({ ":status": 200 });
    stream.write("x");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const client = connect(server);
      const request = client.request({ ":path": "/" });
      request.on("error", () => {});
      request.resume();
      setTimeout(() => {
        client.destroy();
        server.close(() => resolve());
      }, 200);
    });
  });
}

// C: a dynamic 'ready' listener on a client stream hears it before the response
{
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const client = connect(server);
      const request: any = client.request({ ":path": "/" });
      request.on("ready", () => lines.push("C ready"));
      request.on("response", () => lines.push("C response"));
      request.on("error", () => {});
      request.resume();
      request.on("end", () => {
        client.destroy();
        server.close(() => resolve());
      });
    });
  });
}

for (const line of lines) console.log(line);
