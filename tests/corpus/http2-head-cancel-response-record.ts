// A cancelled HTTP/2 HEAD response keeps the 'close' listener it registered
// for a later end(). Here the listener captures a typed record that holds the
// response, so the cycle runs response -> listener -> record -> response, and
// all three must be reclaimable while no JavaScript value reaches them.
import * as http2 from "node:http2";

interface Entry {
  response: http2.Http2ServerResponse;
  label: string;
}

const closed: string[] = [];

const server = http2.createServer((request, response) => {
  response.writeHead(200);
  const entry: Entry = { response, label: "head" };
  response.on("close", () => {
    closed.push(entry.label + " " + entry.response.statusCode);
  });
});

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const client = http2.connect(`http://localhost:${port}`);
  let pending = 24;
  for (let i = 0; i < 24; i++) {
    const stream = client.request({ ":method": "HEAD", ":path": "/" });
    stream.on("error", () => {});
    stream.on("response", () => stream.close(http2.constants.NGHTTP2_CANCEL));
    stream.on("close", () => {
      if (--pending === 0) {
        client.close();
        server.close(() => console.log("closed", closed.length));
      }
    });
  }
});
