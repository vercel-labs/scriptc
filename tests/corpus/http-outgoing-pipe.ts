// OutgoingMessage.prototype.pipe(): an outgoing message is write-only. Node's
// pipe emits 'error' with ERR_STREAM_CANNOT_PIPE ("Cannot pipe, not readable")
// to the message's error listeners, and with none it throws that error to the
// caller. Both outgoing messages answer the same way.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  if (req.url !== "/") {
    res.end("second");
    return;
  }
  console.log("response pipe start", res.writableEnded, res.destroyed);
  try {
    res.pipe();
    console.log("no throw");
  } catch (error) {
    const e = error as Error;
    console.log("response threw", e.name, e.message, (e as { code?: string }).code);
  }
  let fired = 0;
  res.on("error", (error) => {
    fired += 1;
    console.log("response listener", error.message, (error as { code?: string }).code, fired);
  });
  try {
    res.pipe();
  } catch {
    console.log("unexpected throw");
  }
  console.log("response after", fired, res.writableEnded, res.destroyed);
  res.end("body");
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as { port: number };
  const client = http.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
    response.resume();
    response.on("end", () => {
      console.log("body done", response.statusCode);
      // The client request is an OutgoingMessage too.
      const request = http.request({ host: "127.0.0.1", port, path: "/second" });
      request.on("error", (error) => {
        console.log("request listener", error.message, (error as { code?: string }).code);
      });
      try {
        request.pipe();
        console.log("request no throw");
      } catch (error) {
        console.log("request threw", (error as Error).message);
      }
      request.on("response", (second) => second.resume());
      request.on("close", () => server.close(() => console.log("closed")));
      request.end();
    });
  });
  client.on("error", (error) => console.log("client error", error.message));
});
