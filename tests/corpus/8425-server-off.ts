// server.off / removeListener: the LAST registered listener for the same
// function leaves that event's list (Node's removeListener order), the
// remaining listeners still run, and removing an unregistered function is
// a no-op. The EADDRINUSE from a second listen on a bound port is the real
// event here.
import * as net from "node:net";

const first = net.createServer();
first.listen(0, "127.0.0.1", () => {
  const port = first.address().port;
  const second = net.createServer();
  const removed = (err: Error) => console.log("removed listener ran", (err as NodeJS.ErrnoException).code);
  const kept = (err: Error) => console.log("kept listener ran", (err as NodeJS.ErrnoException).code);
  second.on("error", removed);
  second.on("error", kept);
  second.off("error", removed);
  second.off("error", () => console.log("never registered"));
  second.listen(port, "127.0.0.1", () => {
    console.log("unexpected: second listen succeeded");
    second.close();
  });
  setTimeout(() => {
    console.log("closing");
    second.close();
    first.close(() => console.log("first closed"));
  }, 20);
});
