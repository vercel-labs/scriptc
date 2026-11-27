// A peer that never reads and then drops the connection while the upload is
// in flight: the request errors, and the writes whose bytes had reached the
// socket answer their callbacks with ERR_STREAM_DESTROYED after 'close'
// (Node's afterWrite on a destroyed stream).
import * as http from "node:http";
import * as net from "node:net";

const server = net.createServer((sock: net.Socket) => {
  sock.once("data", () => console.log("server got bytes"));
  setTimeout(() => sock.destroy(), 40);
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const req = http.request({ port, host: "127.0.0.1", method: "POST", path: "/" });
  const chunk = Buffer.alloc(256 * 1024, 97);
  let i = 0;
  let reported = false;
  const tick = () => {
    if (i >= 64) {
      req.end(() => console.log("end cb"));
      return;
    }
    i += 1;
    req.write(chunk, (err?: NodeJS.ErrnoException) => {
      if (err && !reported) {
        reported = true;
        console.log("first write error", err.code, "destroyed", req.destroyed);
      }
    });
    setTimeout(tick, 5);
  };
  req.on("error", (e) => console.log("req error", (e as NodeJS.ErrnoException).code, "destroyed", req.destroyed));
  req.on("close", () => console.log("req close destroyed", req.destroyed));
  tick();
  setTimeout(() => server.close(), 900);
});
