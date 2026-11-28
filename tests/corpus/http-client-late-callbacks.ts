// Callbacks that arrive after a request ended settle the way Node settles
// them: a write made right after end() reports Node's write-after-end error
// on the message's 'error' list (the callback receives it too), and a
// callback registered once the request has finished is answered at once —
// end()'s with ERR_STREAM_ALREADY_FINISHED, a write's with
// ERR_STREAM_WRITE_AFTER_END and no 'error' event.
import * as http from "node:http";
import * as net from "node:net";

const show = (err?: NodeJS.ErrnoException): string =>
  err === undefined ? "none" : err.code + " " + JSON.stringify(err.message);

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  req.resume();
  setTimeout(() => res.end("ok"), 50);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const req = http.request({ port, host: "127.0.0.1", path: "/" });
  req.on("error", (err: NodeJS.ErrnoException) => console.log("req error", show(err)));
  req.end(() => console.log("end cb"));
  // the request ended, its socket is still attached
  const early = req.write("x", (err?: NodeJS.ErrnoException) => console.log("write cb", show(err)));
  console.log("write ret", early);
  req.on("response", (res: http.IncomingMessage) => {
    res.resume();
    res.on("end", () => {
      console.log("-- after response (finished) --");
      req.end((err?: NodeJS.ErrnoException) => console.log("late end cb", show(err)));
      const late = req.write("y", (err?: NodeJS.ErrnoException) =>
        console.log("late write cb", show(err)),
      );
      console.log("late write ret", late);
      setTimeout(() => server.close(), 150);
    });
  });
});
