// A completed request answers callbacks that arrive late: end()'s callback
// runs at once (Node's synchronous answer), and a write's callback completes
// with Node's write-after-end error instead of joining a list that never
// fires (the callback takes the error; the 'error' event is the no-callback
// form's report).
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  req.resume();
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const req = http.request({ port, host: "127.0.0.1", path: "/" });
  req.on("response", (res: http.IncomingMessage) => {
    res.resume();
    res.on("end", () => {
      req.end(() => console.log("late end cb"));
      const accepted = req.write("x", (err?: Error) =>
        console.log("late write cb", (err as NodeJS.ErrnoException | undefined)?.code),
      );
      console.log("late write ret", accepted);
      setTimeout(() => server.close(), 100);
    });
  });
  req.on("error", (err: NodeJS.ErrnoException) => console.log("req error", err.code));
  req.end(() => console.log("end cb"));
});
