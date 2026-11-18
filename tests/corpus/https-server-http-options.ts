// HTTPS ServerOptions extends the HTTP option surface: the modeled
// http.createServer options initialize the same server fields through the
// same constructor-order setters (headersTimeout's default and range check
// included), and the server still serves over TLS.
import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as net from "node:net";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

function fields(label: string, server: https.Server): void {
  console.log(
    label,
    server.requestTimeout,
    server.headersTimeout,
    server.keepAliveTimeout,
    server.keepAliveTimeoutBuffer,
  );
}

const literal = https.createServer(
  {
    cert,
    key,
    requestTimeout: 12000,
    headersTimeout: 5000,
    keepAliveTimeout: 2000,
    keepAliveTimeoutBuffer: 100,
    connectionsCheckingInterval: 30000,
    maxHeaderSize: 8192,
    rejectNonStandardBodyWrites: true,
    requireHostHeader: false,
    joinDuplicateHeaders: true,
  },
  () => {},
);
fields("literal", literal);
literal.close();

const defaults = https.createServer({ cert, key }, () => {});
fields("defaults", defaults);
defaults.close();

// headersTimeout's default derives from requestTimeout: min(60000, requestTimeout).
const derived = https.createServer({ cert, key, requestTimeout: 1500 }, () => {});
fields("derived", derived);
derived.close();

// Literal order: an effectful TLS initializer runs before the HTTP option it
// changes, so the later read sees the new value.
let pendingTimeout = 0;
function reloadCert() {
  pendingTimeout = 8000;
  return cert;
}
const ordered = https.createServer(
  { cert: reloadCert(), key, requestTimeout: pendingTimeout },
  () => {},
);
fields("order", ordered);
ordered.close();

// An effectful option value keeps literal order through the runtime walk.
function nextBuffer() {
  return 250;
}
const effectful = https.createServer(
  { cert, key, keepAliveTimeoutBuffer: nextBuffer() },
  () => {},
);
fields("effectful", effectful);
effectful.close();

// A literal whose TLS side rides the runtime walk (ca/requestCert) reads the
// same HTTP-side members.
const clientAuth = https.createServer(
  { cert, key, ca, requestCert: false, requestTimeout: 7000, headersTimeout: 6000 },
  () => {},
);
fields("walk", clientAuth);
clientAuth.close();

try {
  https.createServer({ cert, key, requestTimeout: 1000, headersTimeout: 2000 }, () => {});
} catch (err) {
  if (err instanceof Error) {
    console.log(err.name, (err as NodeJS.ErrnoException).code, err.message);
  }
}

// A bound (runtime-walked) options record reads the same HTTP-side members.
const recorded = {
  cert,
  key,
  requestTimeout: 4000,
  headersTimeout: 3000,
  keepAliveTimeout: 1500,
  keepAliveTimeoutBuffer: 200,
};
const fromRecord = https.createServer(recorded, () => {});
fields("record", fromRecord);
fromRecord.close();

const badRecord = { cert, key, requestTimeout: 1000, headersTimeout: 2000 };
try {
  https.createServer(badRecord, () => {});
} catch (err) {
  if (err instanceof Error) {
    console.log(err.name, (err as NodeJS.ErrnoException).code, err.message);
  }
}

const server = https.createServer(
  { cert, key, requestTimeout: 5000, headersTimeout: 4000, keepAliveTimeout: 1000 },
  (_req, res) => {
    res.end("ok");
  },
);
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const req = https.request(
    { host: "127.0.0.1", port, path: "/", ca, agent: false },
    (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        console.log("served", res.statusCode, body);
        server.close(() => {});
      });
    },
  );
  req.on("error", (err: NodeJS.ErrnoException) => {
    console.log("error", err.code);
    server.close(() => {});
  });
  req.end();
});
