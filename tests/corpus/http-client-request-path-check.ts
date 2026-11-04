// http.request checks the path before it sends anything: characters outside
// U+0021..U+00FF throw ERR_UNESCAPED_CHARACTERS and no request is made.
// Latin-1 characters and DEL pass.
import * as http from "node:http";

const paths = ["/plain", "/latinéÿ", "/del\u007f", "/space here", "/tab\there", "/wideĀ", "/emoji\u{1f600}"];

const server = http.createServer((req, res) => {
  console.log("served", JSON.stringify(req.url));
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  for (const path of paths) {
    try {
      const req = http.request({ host: "127.0.0.1", port, path });
      req.on("error", () => {});
      req.destroy();
      console.log("accepted", JSON.stringify(path));
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      console.log("threw", JSON.stringify(path), e.name, e.code, e.message);
    }
  }
  http.get({ host: "127.0.0.1", port, path: "/after" }, (res) => {
    res.resume();
    res.on("end", () => server.close());
  });
});
