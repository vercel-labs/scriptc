// https.Server.close's return value and its not-running error, before listen
// and on a second close — the rows the header-only program cannot type.
import fs from "node:fs";
import https from "node:https";

const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const idle = https.createServer({ cert, key }, (req, res) => res.end("never"));
console.log("close returns server", idle.close((err) => {
  console.log("never-listened close", err && err.code, err && err.message);
}) === idle);

const server = https.createServer({ cert, key }, (req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  server.close(() => {
    server.close((err) => {
      console.log("second close", err && err.code, err && err.message);
    });
  });
});
