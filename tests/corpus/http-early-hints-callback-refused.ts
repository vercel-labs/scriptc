// A writeEarlyHints whose extra header fails validation sends no 103 and must
// not queue its callback: nothing was written for the callback to follow.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  try {
    res.writeEarlyHints({ link: "</a.css>; rel=preload", "x-bad": "a\r\nInjected: yes" }, () => {
      console.log("callback ran");
    });
    console.log("accepted");
  } catch (e) {
    console.log("threw", (e as NodeJS.ErrnoException).code);
  }
  setTimeout(() => res.end("ok"), 150);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
    res.resume();
    res.on("end", () => {
      console.log("client end", res.statusCode);
      server.close();
    });
  }).on("error", (e) => console.log("error", e.message));
});
