// Node's https.Server constructor reads the HTTP options before the TLS
// fields (storeHTTPOptions runs ahead of the secure context), so a TLS
// accessor that changes a binding an HTTP option reads does not move the
// value the server takes.
import fs from "node:fs";
import https from "node:https";

const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");

let timeoutValue = 4000;
const options = {
  get requestTimeout() {
    return timeoutValue;
  },
  get cert() {
    timeoutValue = 9000;
    return cert;
  },
  key,
};

const server = https.createServer(options, () => {});
console.log("order", server.requestTimeout, server.headersTimeout);
server.close();
