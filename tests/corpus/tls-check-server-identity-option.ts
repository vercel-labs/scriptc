// tls.connect({ checkServerIdentity }): the caller's verifier replaces the
// builtin hostname check — an accepting verifier lets a name-mismatched
// leaf through when the chain verifies, and a rejecting one fails the
// connection with its own error. Without the option the builtin check
// reports Node's alternative-name error.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);
const messageOf = (err: unknown): string => JSON.stringify((err as Error).message);

type Case = { label: string; check: ((hostname: string, cert: unknown) => Error | undefined) | null };
const cases: Case[] = [
  {
    label: "accept",
    // the chain verifies, so the caller's verifier decides the identity
    check: (hostname, peer) => {
      say("accept-called", hostname, typeof peer);
      return undefined;
    },
  },
  {
    label: "reject",
    check: () => {
      const err = new Error("certificate pin mismatch");
      (err as { code?: string }).code = "ERR_PIN_MISMATCH";
      return err;
    },
  },
  { label: "builtin", check: null },
];

const server = tls.createServer({ key, cert }, (socket) => {
  socket.on("error", () => {});
  socket.end("bye");
});

const next = (): void => {
  const entry = cases.shift();
  if (entry === undefined) {
    server.close(() => {
      say("server-closed");
      console.log(out.join("\n"));
    });
    return;
  }
  let message: string | null = null;
  const port = (server.address() as { port: number }).port;
  const onConnect = (): void => {
    message = "connected";
  };
  const check = entry.check;
  const client =
    check !== null
      ? tls.connect(
          {
            port,
            host: "127.0.0.1",
            ca,
            rejectUnauthorized: true,
            checkServerIdentity: (hostname: string, peer: object) => check(hostname, peer),
          },
          onConnect,
        )
      : tls.connect({ port, host: "127.0.0.1", ca, rejectUnauthorized: true }, onConnect);
  client.on("data", () => {});
  client.on("error", (err) => {
    say(entry.label, "error", codeOf(err), messageOf(err));
    client.destroy();
    next();
  });
  client.on("close", () => {
    if (message !== null) {
      say(entry.label, message);
      next();
    }
  });
};

server.listen(0, "127.0.0.1", next);
