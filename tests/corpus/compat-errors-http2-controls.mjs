// Two http2 control failures the errors chapter documents: additional
// headers after the response has been initiated (ERR_HTTP2_HEADERS_AFTER_
// RESPOND), and trailing headers before the wantTrailers event
// (ERR_HTTP2_TRAILERS_NOT_READY). One request per case, so the client
// always sees a completed response.
import http2 from "node:http2";

const lines = [];
const show = (label, fn) => {
  try {
    fn();
    lines.push(`${label} ok`);
  } catch (error) {
    lines.push(`${label} ${error.name} ${error.code} ${JSON.stringify(error.message)}`);
  }
};

const cases = {
  "/info": (stream) => {
    stream.respond({ ":status": 200 });
    show("info after respond", () => stream.additionalHeaders({ ":status": 103 }));
    stream.end("ok");
  },
  "/trailers": (stream) => {
    stream.on("wantTrailers", () => stream.sendTrailers({ "x-t": "2" }));
    stream.respond({ ":status": 200, trailer: "x-t" });
    show("trailers before wantTrailers", () => stream.sendTrailers({ "x-t": "1" }));
    stream.end("ok");
  },
};

const server = http2.createServer();
server.on("stream", (stream, headers) => {
  stream.on("error", () => {});
  const handler = cases[headers[":path"]];
  if (handler) handler(stream);
  else {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
client.on("error", () => {});
await Promise.all(
  Object.keys(cases).map(
    (path) =>
      new Promise((resolve) => {
        const request = client.request({ ":path": path });
        request.on("error", () => {});
        request.on("response", () => request.resume());
        request.on("close", () => resolve(undefined));
        request.end();
      }),
  ),
);
client.close();
await new Promise((resolve) => server.close(resolve));
console.log(lines.sort().join("\n"));
