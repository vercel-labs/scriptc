// tlsSocket.setMaxSendFragment(size): Node's validation ladder (a
// non-number throws ERR_INVALID_ARG_TYPE, a non-integer or infinite value
// ERR_OUT_OF_RANGE), the 512..16384 range that answers false outside it,
// and the cap itself — a 2000-byte write reaches the peer in fragments no
// larger than the size. The call works before the handshake completes too.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const attempts: string[] = [];
function attempt(label: string, run: () => unknown): void {
  try {
    attempts.push(`${label} ${String(run())}`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    attempts.push(`${label} ${err.name} ${err.code} ${err.message}`);
  }
}

const chunks: number[] = [];
const server = tls.createServer({ key, cert }, (sock) => {
  sock.on("data", (chunk: Buffer) => chunks.push(chunk.length));
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca });
  attempt("early", () => client.setMaxSendFragment(2048));
  client.on("error", (err: Error) => console.log("error", err.message));
  client.on("secureConnect", () => {
    attempt("string", () => client.setMaxSendFragment("x" as unknown as number));
    attempt("nan", () => client.setMaxSendFragment(Number.NaN));
    attempt("frac", () => client.setMaxSendFragment(512.5));
    attempt("inf", () => client.setMaxSendFragment(Number.POSITIVE_INFINITY));
    attempt("low", () => client.setMaxSendFragment(511));
    attempt("high", () => client.setMaxSendFragment(16385));
    attempt("negative", () => client.setMaxSendFragment(-1));
    attempt("huge", () => client.setMaxSendFragment(1e9));
    attempt("set", () => client.setMaxSendFragment(512));
    client.write(Buffer.alloc(2000, 0x61));
    client.end();
  });
  client.on("data", () => {});
  client.on("close", () => {
    server.close(() => {
      for (const line of attempts) console.log(line);
      console.log("chunks", chunks.join(","));
    });
  });
});
