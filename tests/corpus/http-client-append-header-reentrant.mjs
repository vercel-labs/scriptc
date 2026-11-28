// appendHeader validates (and therefore coerces) the value it is given; a
// lazy value may remove the very header being appended while it runs. The
// slot appendHeader continues with is the one left after that coercion: the
// header is gone, so the coerced value is set anew.
import http from "node:http";

let pending = null;
const lazy = {
  toString() {
    if (pending !== null) {
      const request = pending;
      pending = null;
      request.removeHeader("x-a");
    }
    return "2";
  },
};

const server = http.createServer((req, res) => {
  console.log("srv x-a", JSON.stringify(req.headers["x-a"] ?? null));
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const req = http.request({
    port,
    host: "127.0.0.1",
    path: "/",
    agent: false,
    headers: { connection: "close" },
  });
  req.on("error", (e) => console.log("req error", e.code));
  req.setHeader("x-a", "1");
  pending = req;
  req.appendHeader("x-a", lazy);
  console.log("appended");
  req.on("response", (res) => {
    console.log("status", res.statusCode);
    res.resume();
    res.on("end", () => server.close());
  });
  req.end();
});
