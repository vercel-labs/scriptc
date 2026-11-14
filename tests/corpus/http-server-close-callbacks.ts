// server.close([callback]) reports through its callback: a server that
// never listened answers ERR_SERVER_NOT_RUNNING ("Server is not
// running."), closing a listening server answers nothing, and a second
// close of an already closed server answers ERR_SERVER_NOT_RUNNING again.
// close() returns the server both ways, and the 'close' event fires once.
import * as http from "node:http";

function show(label: string, err?: Error): void {
  if (err === undefined) console.log(label, "no error");
  else console.log(label, (err as NodeJS.ErrnoException).code, err.message);
}

const never = http.createServer();
console.log("never listening", never.listening);
const returned = never.close((err) => show("never close", err));
console.log("returns server", returned === never);
never.close((err) => show("never close again", err));

const server = http.createServer((req, res) => res.end("ok"));
let closes = 0;
server.on("close", () => {
  closes++;
  console.log("close event", closes);
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  http.get({ port, host: "127.0.0.1", path: "/" }, (res) => {
    res.resume();
    res.on("end", () => {
      const ret = server.close((err) => {
        show("close", err);
        console.log("listening after close", server.listening);
        server.close((err2) => {
          show("second close", err2);
          console.log("events", closes);
        });
      });
      console.log("close returns server", ret === server);
    });
  });
});
