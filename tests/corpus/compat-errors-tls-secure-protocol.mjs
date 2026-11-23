// tls.createSecureContext validates secureProtocol: unknown methods and the
// disabled SSLv2/SSLv3 families raise ERR_TLS_INVALID_PROTOCOL_METHOD, and an
// explicit version beside it raises ERR_TLS_PROTOCOL_VERSION_CONFLICT.
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";

const attempt = (label, options) => {
  try {
    tls.createSecureContext(options);
    console.log(label, "ok");
  } catch (error) {
    console.log(label, error.name, error.code, JSON.stringify(error.message));
  }
};

for (const method of ["bogus", "SSLv2_method", "SSLv2_client_method", "SSLv3_method", "TLSv1_3_method", "bogus\u0000tail"]) {
  attempt(method, { secureProtocol: method });
}
attempt("valid", { secureProtocol: "TLSv1_2_method" });
attempt("valid-server", { secureProtocol: "TLSv1_2_server_method" });
attempt("generic", { secureProtocol: "TLS_method" });
attempt("generic-ssl", { secureProtocol: "SSLv23_method" });
attempt("conflict", { secureProtocol: "bogus", minVersion: "TLSv1.2" });
attempt("conflict-number", { secureProtocol: 1, maxVersion: "TLSv1.2" });

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);
const ca = readFileSync(`${D}/ca.pem`);
const server = tls.createServer({ cert, key, secureProtocol: "TLSv1_2_method" }, (socket) => {
  console.log("negotiated", socket.getProtocol());
  socket.end();
});
server.on("tlsClientError", (error) => console.log("tlsClientError", error.code));
const port = await new Promise((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
);
await new Promise((done) => {
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca });
  client.on("secureConnect", () => client.end());
  client.on("close", () => done(undefined));
});
server.close();

{
  // SSLv23_method caps the range at TLS 1.2 in Node.
  const server = tls.createServer({ cert, key, secureProtocol: "SSLv23_method" }, (socket) => {
    console.log("sslv23-negotiated", socket.getProtocol());
    socket.end();
  });
  server.on("tlsClientError", () => {});
  const port = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
  await new Promise((done) => {
    const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca });
    client.on("secureConnect", () => client.end());
    client.on("close", () => done(undefined));
  });
  server.close();
}
