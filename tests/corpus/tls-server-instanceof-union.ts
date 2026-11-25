// instanceof tls.Server over a server-or-null value and over untyped values:
// the check follows the value.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const server = tls.createServer({ key, cert }, () => {});
function maybeServer(which: boolean): tls.Server | null {
  return which ? server : null;
}
console.log("server", maybeServer(true) instanceof tls.Server);
console.log("null", maybeServer(false) instanceof tls.Server);

const untypedServer: unknown = server;
const untypedObject: unknown = { list: () => {} };
console.log("untyped", untypedServer instanceof tls.Server, untypedObject instanceof tls.Server);

server.close();
