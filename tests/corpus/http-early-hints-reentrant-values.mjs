// The informational headers object is dynamic when the response reaches an
// untyped helper: every value is coerced (toString runs user code) before it
// is written. A value that deletes its own entry during that coercion must not
// leave the conversion holding a freed value.
import http from "node:http";

function sendHints(res, hints) {
  res.writeEarlyHints(hints);
  res.writeHead(200);
  res.end("ok");
}

const server = http.createServer((req, res) => {
  const hints = {
    link: "</a.css>; rel=preload; as=style",
    "x-self": {
      toString() {
        delete hints["x-self"];
        return "self-value";
      },
    },
  };
  sendHints(res, hints);
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  http
    .get({ port, host: "127.0.0.1", path: "/" })
    .on("error", () => server.close())
    .on("response", (res) => {
      console.log("status", res.statusCode);
      res.resume();
      res.on("end", () => server.close());
    });
});
