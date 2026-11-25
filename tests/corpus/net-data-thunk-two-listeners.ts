// One module registers both an HTTP/2 stream's 'data' listener and a net
// socket's 'data' listener. Both code paths name the same runtime thunk,
// which used to be declared with two different signatures; the module then
// failed LLVM verification and the program did not compile.
import * as http2 from "node:http2";
import * as net from "node:net";

const h2 = http2.createServer();
h2.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
  console.log("stream", headers[":path"]);
  stream.on("data", (chunk: Uint8Array) => {
    console.log("stream data", chunk.length);
  });
  stream.on("end", () => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
});

const plain = net.createServer((socket) => {
  socket.on("data", (chunk: Buffer) => socket.write("echo:" + chunk.toString("utf8")));
});

const h2Part = (): void => {
  const port = (h2.address() as net.AddressInfo).port;
  const client = http2.connect("http://127.0.0.1:" + port);
  const req = client.request({ ":path": "/body" });
  req.on("response", (headers: http2.IncomingHttpHeaders) =>
    console.log("response", headers[":status"]),
  );
  let body = "";
  req.on("data", (chunk: Uint8Array) => (body += Buffer.from(chunk).toString("utf8")));
  req.on("end", () => {
    console.log("body", JSON.stringify(body));
    client.close();
    h2.close(() => {
      const plainPort = (plain.address() as net.AddressInfo).port;
      const socket = net.connect(plainPort, "127.0.0.1", () => socket.write("ping"));
      socket.on("data", (chunk: Buffer) => {
        console.log("echo", JSON.stringify(chunk.toString("utf8")));
        socket.end();
      });
      socket.on("close", () => plain.close());
    });
  });
  req.end();
};

plain.listen(0, "127.0.0.1", () => {
  h2.listen(0, "127.0.0.1", h2Part);
});
