// How node:http2 reports header fields that a peer sent more than once:
// one string joined with ", ", `cookie` joined with "; ", and `set-cookie`
// as an array of every field, also when there is one. The compatibility
// response sends repeated fields through setHeader with an array and
// through appendHeader; the core API sends single fields here.
import http2 from "node:http2";

function get(port, path) {
  return new Promise((resolve) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    const request = client.request({ ":path": `${path}` });
    request.on("response", (headers) => {
      console.log(
        path,
        headers[":status"],
        JSON.stringify(headers["x-a"]),
        JSON.stringify(headers["cookie"]),
        JSON.stringify(headers["set-cookie"]),
        JSON.stringify(headers["x-single"]),
      );
    });
    request.resume();
    request.on("end", () => client.close(() => resolve(undefined)));
    request.end();
  });
}

// Core API: single fields.
await new Promise((resolve) => {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 201, "set-cookie": "only=1", "x-a": "1", cookie: "k=1" });
    stream.end("ok");
  });
  server.listen(0, "127.0.0.1", async () => {
    await get(server.address().port, "/one");
    server.close(() => resolve(undefined));
  });
});

// Compatibility API.
await new Promise((resolve) => {
  const server = http2.createServer((request, response) => {
    if (request.url === "/append") {
      response.appendHeader("x-a", "1");
      response.appendHeader("x-a", "2");
      response.appendHeader("set-cookie", "a=1");
      response.appendHeader("set-cookie", ["b=2", "c=3"]);
      response.appendHeader("cookie", "k=1");
      response.appendHeader("cookie", "j=2");
      response.setHeader("x-single", "s");
    } else {
      response.setHeader("x-a", ["a", "b"]);
      response.setHeader("set-cookie", "only=1");
    }
    response.end();
  });
  server.listen(0, "127.0.0.1", async () => {
    await get(server.address().port, "/append");
    await get(server.address().port, "/set");
    server.close(() => resolve(undefined));
  });
});
