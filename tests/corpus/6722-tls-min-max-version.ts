// tls.connect and tls.createServer with minVersion and maxVersion: the
// handshake picks the highest version both ranges allow and getProtocol()
// reports it. A range the server does not share fails with
// ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION, a client range with neither TLSv1.2
// nor TLSv1.3 fails with ERR_SSL_NO_PROTOCOLS_AVAILABLE once the handshake
// starts, and an invalid version or a secureProtocol conflict throws Node's
// TypeError from tls.connect and tls.createServer. null selects the default
// bound, as undefined does.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const ca = readFileSync(dir + "ca.pem");
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");

const upTo12 = tls.createServer({ cert, key, maxVersion: "TLSv1.2" }, (s) => s.end(`server:${s.getProtocol()}`));
const from13 = tls.createServer({ cert, key, minVersion: "TLSv1.3" }, (s) => s.end(`server:${s.getProtocol()}`));
const any = tls.createServer({ cert, key }, (s) => s.end(`server:${s.getProtocol()}`));
const nullBounds = tls.createServer({ cert, key, minVersion: null as any, maxVersion: null as any }, (s) =>
  s.end(`server:${s.getProtocol()}`),
);
for (const maxVersion of [3, "TLSv9"]) {
  try {
    tls.createServer({ cert, key, maxVersion: maxVersion as any });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("createServer", err.name, err.code, err.message);
  }
}

function listen(server: tls.Server): Promise<number> {
  return new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );
}

interface Versions {
  minVersion?: unknown;
  maxVersion?: unknown;
  secureProtocol?: string;
}

function attempt(label: string, port: number, versions: Versions): Promise<void> {
  return new Promise<void>((resolve) => {
    let socket: tls.TLSSocket;
    try {
      const options = {
        host: "localhost",
        port,
        ca,
        minVersion: versions.minVersion as any,
        maxVersion: versions.maxVersion as any,
        secureProtocol: versions.secureProtocol,
      };
      socket = tls.connect(options, () => console.log(label, "client:", socket.getProtocol()));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.log(label, err.name, err.code, err.message);
      resolve();
      return;
    }
    let data = "";
    socket.on("data", (chunk: Buffer) => (data += chunk.toString()));
    socket.on("end", () => {
      console.log(label, data);
      resolve();
    });
    socket.on("error", (err) => {
      console.log(label, "error:", (err as NodeJS.ErrnoException).code);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const p12 = await listen(upTo12);
  const p13 = await listen(from13);
  const pAny = await listen(any);
  await attempt("defaults", pAny, {});
  await attempt("max-1.2", pAny, { maxVersion: "TLSv1.2" });
  await attempt("min-1.3", pAny, { minVersion: "TLSv1.3" });
  await attempt("min-1-against-1.2", p12, { minVersion: "TLSv1" });
  await attempt("min-1.3-against-1.2", p12, { minVersion: "TLSv1.3" });
  await attempt("max-1.2-against-1.3", p13, { maxVersion: "TLSv1.2" });
  await attempt("max-1.1", pAny, { maxVersion: "TLSv1.1" });
  await attempt("min-above-max", pAny, { minVersion: "TLSv1.3", maxVersion: "TLSv1.2" });
  await attempt("null-min", pAny, { minVersion: null });
  const pNull = await listen(nullBounds);
  await attempt("null-server", pNull, {});
  await attempt("null-both", pNull, { minVersion: null, maxVersion: null });
  await attempt("invalid-min", pAny, { minVersion: "TLSv9" });
  await attempt("invalid-max", pAny, { maxVersion: 3 });
  await attempt("conflict", pAny, { minVersion: "TLSv1.2", secureProtocol: "TLSv1_2_method" });
  upTo12.close();
  from13.close();
  any.close();
  nullBounds.close();
}

void main();
