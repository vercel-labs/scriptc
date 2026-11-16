// The typed form of the session 'goaway' listener: (errorCode,
// lastStreamID, opaqueData?) with the opaque data a Buffer when the peer
// attached any. The server sends GOAWAY with its opaque payload after the
// request completes; the client destroys the session and closes the server.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const server = http2.createServer();
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 });
  stream.end("ok");
  stream.session.goaway(0, stream.id, Buffer.from("bye"));
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on(
      "goaway",
      (code: number, last: number, opaque?: Uint8Array) =>
        console.log(`${code} ${last} ${opaque === undefined ? "none" : opaque.length}`),
    );
    client.on("close", () => server.close(() => resolve()));
    client.on("connect", () => {
      const request = client.request({ ":path": "/" });
      request.resume();
      request.on("end", () => {});
      request.end();
    });
    client.on("goaway", () => client.destroy());
  });
});
