// Node checks each option while it reads it, so an invalid early HTTP
// option throws before a later getter runs; and a documented TLS option
// explicitly set to undefined reads as absent.
import fs from "node:fs";
import https from "node:https";

const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");

let getterRan = false;
const invalid = {
  maxHeaderSize: -1,
  get requestTimeout() {
    getterRan = true;
    return 1000;
  },
  cert,
  key,
};
try {
  https.createServer(invalid, () => {});
} catch (err) {
  console.log(err.name, err.code, err.message);
}
console.log("later getter ran", getterRan);

const undefinedTlsOptions = {
  cert,
  key,
  ciphers: undefined,
  sessionTimeout: undefined,
};
const server = https.createServer(undefinedTlsOptions, () => {});
console.log("constructed", server.listening);
server.close();
