// https.Server's close([callback]) answers like http.Server's: a server
// that never listened answers ERR_SERVER_NOT_RUNNING ("Server is not
// running.") through the callback, closing a listening TLS server answers
// nothing, a second close answers ERR_SERVER_NOT_RUNNING again, and
// close() returns the server. 'close' fires for each close.
import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as net from "node:net";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

function show(label: string, err?: Error): void {
  if (err === undefined) console.log(label, "no error");
  else console.log(label, (err as NodeJS.ErrnoException).code, err.message);
}

const never = https.createServer({ cert, key });
console.log("never listening", never.listening);
const returned = never.close((err) => show("never close", err));
console.log("returns server", returned === never);

const server = https.createServer({ cert, key }, (request, response) => response.end("ok"));
let closes = 0;
server.on("close", () => {
  closes++;
  console.log("close event", closes);
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  https.get({ host: "127.0.0.1", port, path: "/", ca, agent: false }, (res) => {
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
