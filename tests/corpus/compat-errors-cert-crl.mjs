// tls.connect({ crl }): a revoked certificate, a CRL outside its validity
// window, one signed by another CA, and a CRL whose signature does not
// verify each report Node's code and message from client verification.
import { readFileSync } from "node:fs";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/crl-leaf.pem`);
const key = readFileSync(`${D}/crl-leaf-key.pem`);
const ca = readFileSync(`${D}/ca.pem`);

try {
  tls.connect({ port: 1, host: "127.0.0.1", crl: "not a crl" }).on("error", () => {});
  console.log("malformed constructed");
} catch (error) {
  console.log("malformed", error.name, error.code, JSON.stringify(error.message));
}

for (const name of [
  "crl-clean",
  "crl-revoked",
  "crl-expired",
  "crl-future",
  "crl-badsig",
  "crl-untrusted",
]) {
  const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
  server.on("tlsClientError", () => {});
  const port = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
  await new Promise((done) => {
    const client = tls.connect({
      port,
      host: "127.0.0.1",
      servername: "localhost",
      ca,
      crl: readFileSync(`${D}/${name}.pem`),
    });
    client.on("secureConnect", () => {
      console.log(name, "secure", client.authorized);
      client.end();
      done(undefined);
    });
    client.on("error", (error) => {
      console.log(name, error.name, error.code, JSON.stringify(error.message));
      done(undefined);
    });
  });
  server.close();
}

{
  // rejectUnauthorized: false still RUNS verification: the socket reports
  // the CRL verdict instead of failing the handshake.
  const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
  server.on("tlsClientError", () => {});
  const port = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
  await new Promise((done) => {
    const client = tls.connect({
      port,
      host: "127.0.0.1",
      servername: "localhost",
      ca,
      crl: readFileSync(`${D}/crl-revoked.pem`),
      rejectUnauthorized: false,
    });
    client.on("secureConnect", () => {
      console.log("relaxed", client.authorized, client.authorizationError);
      client.end();
      done(undefined);
    });
    client.on("error", (error) => {
      console.log("relaxed", error.code);
      done(undefined);
    });
  });
  server.close();
}
