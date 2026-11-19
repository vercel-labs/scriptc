// The https.createServer options value need not be an object literal: a
// compiled class instance carries the same HTTP-side members, and the
// runtime options walk reads them.
import fs from "node:fs";
import https from "node:https";

const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");

class Options {
  constructor() {
    this.cert = cert;
    this.key = key;
    this.requestTimeout = 6000;
    this.headersTimeout = 5000;
    this.keepAliveTimeout = 1500;
    this.keepAliveTimeoutBuffer = 300;
  }
}

const server = https.createServer(new Options(), () => {});
console.log(
  "instance",
  server.requestTimeout,
  server.headersTimeout,
  server.keepAliveTimeout,
  server.keepAliveTimeoutBuffer,
);
server.close();
