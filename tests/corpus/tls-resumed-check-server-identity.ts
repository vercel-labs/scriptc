// tls.connect({ session, checkServerIdentity }): a resumed connection skips
// the caller's verifier, as Node does — the session was verified when it was
// established, so the second connection answers reused true with no call.
// The first, non-resumed connection runs the verifier with the peer
// certificate.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const server = tls.createServer({ key, cert }, (socket) => socket.end());
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

async function connect(session: Buffer | undefined, label: string): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    let calls = 0;
    let saved = session;
    const socket = tls.connect(
      {
        port,
        host: "127.0.0.1",
        servername: "localhost",
        ca,
        session,
        checkServerIdentity: (host: string, peer: tls.PeerCertificate) => {
          calls++;
          console.log(label, "check", host, peer.subject?.CN ?? "none", peer.raw?.length ?? 0);
          return undefined;
        },
      },
      () => {
        console.log(label, "secure reused", socket.isSessionReused(), "checks", calls);
      },
    );
    socket.on("session", (value: Buffer) => {
      saved = value;
    });
    socket.on("data", () => {});
    socket.on("error", (err: Error) => {
      console.log(label, "error", (err as NodeJS.ErrnoException).code);
      resolve(saved);
    });
    socket.on("close", () => {
      setTimeout(() => resolve(saved), 10);
    });
  });
}

const first = await connect(undefined, "first");
const second = await connect(first, "second");
console.log("second session", second !== undefined);
server.close();
