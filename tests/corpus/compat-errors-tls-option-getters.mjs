// A secureProtocol or version option defined by a getter is read the way
// Node reads it: its value takes part in the checks, a getter that throws
// propagates, and a valid method still fixes the version range.
import { readFileSync } from "node:fs";
import tls from "node:tls";

const attempt = (label, options) => {
  try {
    tls.createSecureContext(options);
    console.log(label, "ok");
  } catch (error) {
    console.log(label, error.name, error.code, JSON.stringify(error.message));
  }
};

const withGetter = (key, get) => Object.defineProperty({}, key, { get });
attempt("invalid", withGetter("secureProtocol", () => "bogus"));
attempt("sslv2", withGetter("secureProtocol", () => "SSLv2_method"));
attempt("valid", withGetter("secureProtocol", () => "TLSv1_2_method"));
attempt("throws", withGetter("secureProtocol", () => {
  throw new RangeError("boom");
}));
attempt("min-version", withGetter("minVersion", () => 5));

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);
const ca = readFileSync(`${D}/ca.pem`);

const options = { cert, key };
Object.defineProperty(options, "secureProtocol", { get: () => "TLSv1_2_method" });
const server = tls.createServer(options, (socket) => {
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
