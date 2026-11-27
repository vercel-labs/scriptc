// A write with no bytes still completes: its callback runs once the bytes
// already queued have reached the socket, with nothing else having to follow —
// before the head, after it, and out of an explicit cork.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  if (req.url === "/res") {
    res.flushHeaders();
    console.log("res empty string:", res.write("", () => console.log("res empty string callback")));
    console.log("res empty buffer:", res.write(Buffer.alloc(0), () => console.log("res empty buffer callback")));
    res.write("head chunk");
    setTimeout(() => {
      console.log("res empty after head:", res.write("", () => console.log("res empty after head callback")));
      setTimeout(() => {
        console.log(
          "res empty buffer after head:",
          res.write(Buffer.alloc(0), () => console.log("res empty buffer after head callback")),
        );
        res.end("ok", () => console.log("res end callback"));
      }, 100);
    }, 100);
    return;
  }
  req.resume();
  req.on("end", () => res.end("ok"));
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const first = http.get({ host: "127.0.0.1", port, path: "/res" }, (res) => {
    res.resume();
    res.on("end", () => {
      console.log("client end", res.statusCode);
      const post = http.request({ host: "127.0.0.1", port, method: "POST", path: "/req" }, (res2) => {
        res2.resume();
        res2.on("end", () => {
          console.log("post end", res2.statusCode);
          server.close();
        });
      });
      post.on("socket", () => {
        post.write("first");
        setTimeout(() => {
          console.log("req empty:", post.write("", () => console.log("req empty callback")));
          post.cork();
          post.write("", () => console.log("corked req empty callback"));
          setTimeout(() => {
            console.log("uncork");
            post.uncork();
            post.end("tail", () => console.log("req end callback"));
          }, 100);
        }, 100);
      });
    });
  });
  first.on("error", (e) => console.log("first error", e.message));
});
