// Node reads the https.createServer options through ordinary property
// access, so accessor members are live: a get requestCert() enables client
// certificate checking, and a get requestTimeout() initializes the server.
import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as tls from "node:tls";
import type { AddressInfo } from "node:net";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const client = readFileSync("tests/fixtures/server/certs/client.pem");
const clientKey = readFileSync("tests/fixtures/server/certs/client-key.pem");

const options = {
  get cert() {
    return cert;
  },
  get key() {
    return key;
  },
  get ca() {
    return ca;
  },
  get requestCert() {
    return true;
  },
  get rejectUnauthorized() {
    return false;
  },
  get requestTimeout() {
    return 7000;
  },
  get headersTimeout() {
    return 6000;
  },
};

const server = https.createServer(options, (req, res) => {
  const socket = req.socket as tls.TLSSocket;
  res.end(`${socket.authorized} ${socket.authorizationError === null ? "none" : "error"}`);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  console.log("timeouts", server.requestTimeout, server.headersTimeout);
  const probe = (withCert: boolean, done: () => void): void => {
    const requestOptions: https.RequestOptions = {
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
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        console.log(withCert ? "client cert" : "no cert", res.statusCode, body);
        done();
      });
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      console.log(withCert ? "client cert" : "no cert", "error", err.code);
      done();
    });
    req.end();
  };
  probe(true, () =>
    probe(false, () => {
      server.close(() => console.log("closed"));
    }),
  );
});
