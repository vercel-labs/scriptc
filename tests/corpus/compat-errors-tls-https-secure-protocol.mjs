// https.createServer's runtime options run the same secureProtocol checks as
// tls.createServer: unknown methods and the disabled SSLv2/SSLv3 families
// raise ERR_TLS_INVALID_PROTOCOL_METHOD, and an explicit version beside it
// raises ERR_TLS_PROTOCOL_VERSION_CONFLICT.
import { readFileSync } from "node:fs";
import https from "node:https";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);

for (const [label, method, minVersion] of [
  ["bogus", "bogus", undefined],
  ["conflict", "TLSv1_2_method", "TLSv1.2"],
  ["valid", "TLSv1_2_method", undefined],
]) {
  try {
    const options = { cert, key, secureProtocol: method };
    if (minVersion !== undefined) options.minVersion = minVersion;
    const server = https.createServer(options, () => {});
    console.log("https-create", label, "ok");
    server.close();
  } catch (error) {
    console.log("https-create", label, error.code, JSON.stringify(error.message));
  }
}
