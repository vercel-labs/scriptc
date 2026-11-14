// An untyped request's write(chunk, encoding, callback): the encoding slot
// is consumed even when it holds undefined or another falsy value (Node
// treats those as "no encoding"), so the callback that follows is still
// found and fires with no error. A truthy value that is not an encoding is
// ERR_UNKNOWN_ENCODING, thrown before anything is buffered.
import http from "node:http";

// Untyped parameters, so the write is dispatched at run time (the
// checked-dynamic form) and its throw is one the caller can catch.
function send(req, chunk, encoding, callback) {
  return req.write(chunk, encoding, callback);
}

const server = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    console.log("server body", JSON.stringify(body));
    res.end("ok");
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/" }, (res) => {
    res.resume();
    res.on("end", () => server.close(() => console.log("closed")));
  });
  console.log("write undefined", send(req, "a", undefined, (err) => console.log("cb undefined", err ?? "none")));
  console.log("write empty", send(req, "b", "", (err) => console.log("cb empty", err ?? "none")));
  console.log("write zero", send(req, "c", 0, (err) => console.log("cb zero", err ?? "none")));
  for (const encoding of [1, true, "bogus"]) {
    try {
      send(req, "z", encoding, () => console.log("cb rejected"));
      console.log("accepted", typeof encoding);
    } catch (err) {
      console.log("threw", typeof encoding, err.code, err.message);
    }
  }
  req.end("d");
});
