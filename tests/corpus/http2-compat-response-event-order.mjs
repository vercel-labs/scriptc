// The order of an http2 compat response's events. end(cb) runs its callback
// when the stream finishes; when the stream closes, the request emits
// 'close', then the response 'finish' and 'close', also when it never
// ended. An end(cb) while the response is ending or closed runs its
// callback on the next tick, and a 'finish' listener added after 'finish'
// never runs. A HEAD request's stream ends its writable side when the
// request arrives, so its end(cb) callback runs with the 'finish'
// listeners, and its response emits nothing when the stream closes before
// end(); a later end() emits both events. A 204, 205 or 304 response's
// stream ends when writeHead sends its headers, so there too the end(cb)
// callback runs after the 'finish' listeners registered before it; a status
// set without writeHead goes out with end(), as for any other status. A stream reset before its body
// went out never runs the end(cb) callback.
import http2 from "node:http2";

const lines = [];
const log = (line) => lines.push(line);

function listen(handler, request, read = true) {
  return new Promise((resolve) => {
    const server = http2.createServer(handler);
    server.listen(0, () => {
      const client = http2.connect(`http://localhost:${server.address().port}`);
      const stream = request(client);
      stream.on("error", () => {});
      if (read) stream.resume();
      stream.on("close", () => {
        client.close();
        server.close(() => setTimeout(resolve, 10));
      });
    });
  });
}

function respond(label) {
  return (req, res) => {
    res.on("finish", () => {
      log(`${label}: finish`);
      res.on("finish", () => log(`${label}: finish listener added in finish`));
      res.end(() => log(`${label}: end callback added in finish`));
    });
    res.on("close", () => {
      log(`${label}: close`);
      res.on("finish", () => log(`${label}: finish listener added in close`));
      res.end(() => log(`${label}: end callback added in close`));
    });
    res.on("finish", () => log(`${label}: finish listener added before end`));
    res.end("ok", () => log(`${label}: end callback`));
    res.end(() => log(`${label}: second end callback`));
    res.on("finish", () => log(`${label}: finish listener added after end`));
    log(`${label}: handler returns`);
  };
}

// A HEAD request differs only in where end(cb) runs.
function respondHead(req, res) {
  res.on("finish", () => log("HEAD: finish listener added before end"));
  res.on("close", () => log("HEAD: close"));
  res.end(() => log("HEAD: end callback"));
  res.on("finish", () => log("HEAD: finish listener added after end"));
}

function abandon(label, endAfterClose) {
  return (req, res) => {
    res.on("finish", () => {
      log(`${label}: finish`);
      res.end(() => log(`${label}: end callback added in finish`));
    });
    res.on("close", () => log(`${label}: close`));
    req.on("close", () => {
      log(`${label}: request close`);
      if (endAfterClose)
        setTimeout(() => {
          log(`${label}: end after the stream closed`);
          res.end(() => log(`${label}: late end callback`));
        }, 5);
    });
  };
}

// The body does not fit the stream's flow-control window, and the client
// resets the stream without reading it.
function respondLarge(req, res) {
  res.on("finish", () => log("reset body: finish"));
  res.on("close", () => log("reset body: close"));
  res.end("x".repeat(1 << 20), () => log(`reset body: end callback ${res.statusCode}`));
}

// A 'finish' listener registered before end(cb), for a status with no body.
function respondStatus(label, status, viaWriteHead) {
  return (req, res) => {
    res.on("finish", () => log(`${label}: finish listener`));
    if (viaWriteHead) res.writeHead(status);
    else res.statusCode = status;
    res.end(() => log(`${label}: end callback`));
  };
}

function cancelSoon(stream) {
  setTimeout(() => stream.close(http2.constants.NGHTTP2_CANCEL), 20);
  return stream;
}

await listen(respond("GET"), (client) => {
  const stream = client.request({ ":path": "/" });
  stream.end();
  return stream;
});
await listen(respondHead, (client) => client.request({ ":path": "/", ":method": "HEAD" }));
await listen(abandon("aborted GET", false), (client) =>
  cancelSoon(client.request({ ":path": "/" })),
);
await listen(abandon("aborted HEAD", true), (client) =>
  cancelSoon(client.request({ ":path": "/", ":method": "HEAD" })),
);
await listen(
  respondLarge,
  (client) => {
    const stream = client.request({ ":path": "/" });
    stream.on("response", () => stream.close(http2.constants.NGHTTP2_CANCEL));
    return stream;
  },
  false,
);
for (const [label, status, viaWriteHead] of [
  ["writeHead 204", 204, true],
  ["writeHead 205", 205, true],
  ["writeHead 304", 304, true],
  ["statusCode 204", 204, false],
]) {
  await listen(respondStatus(label, status, viaWriteHead), (client) => {
    const stream = client.request({ ":path": "/" });
    stream.end();
    return stream;
  });
}
await new Promise((resolve) => setTimeout(resolve, 20));
for (const line of lines) console.log(line);
