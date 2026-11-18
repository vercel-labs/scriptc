// A TLS option getter that deletes an earlier member compacts the options
// record while it is being read. The walk snapshots the member names first
// and reads the certificate members by name, so requestCert still takes
// effect: a client without a certificate cannot complete the handshake.
import fs from "node:fs";
import https from "node:https";

const ca = fs.readFileSync("tests/fixtures/server/certs/ca.pem");
const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const client = fs.readFileSync("tests/fixtures/server/certs/client.pem");
const clientKey = fs.readFileSync("tests/fixtures/server/certs/client-key.pem");

const options = {
  transient: true,
  cert,
  get key() {
    delete options.transient;
    return key;
  },
  requestCert: true,
  ca,
};

const server = https.createServer(options, (req, res) => {
  const socket = req.socket;
  res.end(`${socket.authorized} ${socket.authorizationError === null ? "none" : "error"}`);
});

function probe(port, withCert, label, done) {
  const requestOptions = {
    host: "127.0.0.1",
    port,
    path: "/",
    ca,
    agent: false,
  };
  if (withCert) {
    requestOptions.cert = client;
    requestOptions.key = clientKey;
  }
  const req = https.request(requestOptions, (res) => {
    let body = "";
    res.on("data", (chunk) => {
      body += chunk.toString();
    });
    res.on("end", () => {
      console.log(label, "response", res.statusCode, body);
      done();
    });
  });
  req.on("error", () => {
    console.log(label, "handshake failed true");
    done();
  });
  req.end();
}

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log("transient deleted", !("transient" in options));
  probe(port, true, "client cert", () => {
    probe(port, false, "no cert", () => {
      server.close(() => console.log("closed"));
    });
  });
});
