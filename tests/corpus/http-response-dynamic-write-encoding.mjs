// The encoding slot of an untyped ServerResponse's write() and end(): a
// falsy encoding (undefined, '', 0) is the default and the callback that
// follows it still runs, a truthy non-encoding is ERR_UNKNOWN_ENCODING
// with the value's text, and end() ignores the encoding of a falsy chunk.
import http from "node:http";

// Untyped parameters, so the write is dispatched at run time (the
// checked-dynamic form) and its throw is one the handler can catch.
function send(res, chunk, encoding, callback) {
  return res.write(chunk, encoding, callback);
}

const server = http.createServer((req, res) => {
  const path = req.url;
  if (path === "/strings") {
    console.log("write undefined", send(res, "a", undefined, (err) => console.log("cb undefined", err ?? "none")));
    console.log("write empty", send(res, "b", "", (err) => console.log("cb empty", err ?? "none")));
    console.log("write zero", send(res, "c", 0, (err) => console.log("cb zero", err ?? "none")));
    for (const encoding of [1, true, "bogus"]) {
      try {
        send(res, "z", encoding, () => console.log("cb rejected"));
        console.log("accepted", typeof encoding);
      } catch (err) {
        console.log("threw", typeof encoding, err.code, err.message);
      }
    }
    res.end("d");
    return;
  }
  if (path === "/end-empty") {
    res.write("x", "");
    try {
      res.end("", "bogus");
      console.log("end empty accepted");
    } catch (err) {
      console.log("end empty threw", err.code);
    }
    return;
  }
  res.end("");
});

function get(port, path, done) {
  http.get({ host: "127.0.0.1", port, path }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (part) => {
      text += part;
    });
    res.on("end", () => {
      console.log(path, "body", JSON.stringify(text));
      done();
    });
  });
}

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  get(port, "/strings", () => get(port, "/end-empty", () => server.close(() => console.log("closed"))));
});
