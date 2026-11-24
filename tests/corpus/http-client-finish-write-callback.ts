// A write() issued from the request's own 'finish' listener still reports
// Node's write-after-end error on the message's 'error' list: the response
// has not completed yet, so the message is finished but not settled. The
// callback runs first, then the 'error' event, and the response's 'end'
// follows.
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
  req.on("finish", () => {
    console.log("finish listener");
    const accepted = req.write("z", (err?: NodeJS.ErrnoException) =>
      console.log("finish write cb", show(err)),
    );
    console.log("finish write ret", accepted);
  });
  req.on("response", (res: http.IncomingMessage) => {
    res.resume();
    res.on("end", () => {
      console.log("response end");
      setTimeout(() => server.close(), 50);
    });
  });
  req.end();
});
