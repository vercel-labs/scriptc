// TLS members this runtime's engine (mbedTLS) cannot provide: OCSP
// stapling callbacks, the session-cache callbacks, OpenSSL's message
// trace, the Finished messages and the peer's signature-algorithm list,
// and OpenSSL's cipher and certificate-compression inventories. Each use
// refuses at build time; the compatibility ledger records them as
// not-applicable with the engine reason.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const server = tls.createServer({ key, cert });
// the engine supports neither OCSP stapling nor a session cache (tickets only)
server.on("OCSPRequest", () => {});
server.on("OCSPResponse", () => {});
server.on("newSession", () => {});
server.on("resumeSession", () => {});

const client = tls.connect({ host: "127.0.0.1", port: 1 });
// OpenSSL's message trace, the raw Finished messages and the peer's
// signature-algorithm list are not exposed by the engine
client.enableTrace();
client.getFinished();
client.getPeerFinished();
client.getSharedSigalgs();

// OpenSSL's cipher inventory and certificate-compression algorithms; the
// options that consume them (ciphers, certCompression) are refused too
console.log(tls.getCiphers());
console.log(tls.DEFAULT_CIPHERS);
console.log(tls.getCertificateCompressionAlgorithms());
