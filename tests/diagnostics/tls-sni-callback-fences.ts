// tls.createServer SNICallback forms that have no lowering.
import { readFileSync } from "node:fs";
import * as tls from "node:tls";

const cert = readFileSync("cert.pem");
const key = readFileSync("key.pem");
type Answer = (err: Error | null, ctx?: tls.SecureContext) => void;
function makeSni(): (servername: string, cb: Answer) => void {
  return (_servername, cb) => cb(null, undefined);
}

// SNICallback with options the runtime options walk reads.
tls.createServer({ cert, key, ALPNProtocols: ["h2"], SNICallback: makeSni });
