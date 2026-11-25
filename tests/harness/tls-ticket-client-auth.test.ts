/* A server that requires client certificates must not issue session
 * tickets: a resumed handshake carries no peer certificate, so a ticket
 * would let a later connection stand on an earlier one's authentication.
 * Its SNI contexts verify client certificates against different trust
 * anchors under one shared ticket key, so no ticket may carry one
 * context's verdict into another. Native lane only — Node's server does
 * issue tickets here, so there is no Node oracle for the contract this
 * pins. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as tls from "node:tls";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const fixture = join(repoRoot, "tests/fixtures/tls-ticket-client-auth/main.ts");
const certs = join(repoRoot, "tests/fixtures/server/certs");

interface First {
  /* what getTLSTicket() answered at secureConnect */
  ticketAtConnect: "undefined" | "null" | "buffer";
  /* 'session' events the client saw (a client-auth server issues none) */
  sessionEvents: number;
  /* the session the client could offer a resumption attempt */
  session: Buffer | undefined;
}

function firstConnection(port: number): Promise<First> {
  return new Promise<First>((done) => {
    const ca = readFileSync(join(certs, "ca.pem"));
    const cert = readFileSync(join(certs, "client.pem"));
    const key = readFileSync(join(certs, "client-key.pem"));
    let ticketAtConnect: First["ticketAtConnect"] = "undefined";
    let sessionEvents = 0;
    let session: Buffer | null = null;
    const client = tls.connect({
      port,
      host: "127.0.0.1",
      servername: "localhost",
      ca,
      cert,
      key,
      maxVersion: "TLSv1.3",
    });
    client.on("secureConnect", () => {
      const ticket = client.getTLSTicket();
      ticketAtConnect = ticket === undefined ? "undefined" : ticket === null ? "null" : "buffer";
      session = client.getSession();
    });
    client.on("session", () => {
      sessionEvents += 1;
      session = client.getSession();
    });
    client.on("data", () => {});
    client.on("error", () => done({ ticketAtConnect, sessionEvents, session: undefined }));
    client.on("close", () => {
      done({
        ticketAtConnect,
        sessionEvents,
        session: session === null ? undefined : session,
      });
    });
    setTimeout(() => client.end(), 400);
  });
}

/* A second connection offering the first one's session. name selects the
 * SNI context ("localhost" trusts ca, "other.localhost" trusts ca2); `cert`
 * sends the ca-issued client certificate, and its absence is the certless
 * resumption a ticket would have authorized. */
function attempt(
  port: number,
  name: string,
  session: Buffer | undefined,
  withCert: boolean,
): Promise<{ secure: boolean; error: string | null }> {
  return new Promise((done) => {
    const ca = readFileSync(join(certs, "ca.pem"));
    const options: tls.ConnectionOptions = {
      port,
      host: "127.0.0.1",
      servername: name,
      ca,
      // the served certificate is the localhost one in both contexts
      checkServerIdentity: () => undefined,
      maxVersion: "TLSv1.3",
    };
    if (withCert) {
      options.cert = readFileSync(join(certs, "client.pem"));
      options.key = readFileSync(join(certs, "client-key.pem"));
    }
    if (session !== undefined) options.session = session;
    let secure = false;
    let error: string | null = null;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      done({ secure, error });
    };
    const client = tls.connect(options);
    client.on("secureConnect", () => {
      secure = true;
    });
    client.on("data", () => {});
    client.on("error", (e: Error & { code?: string }) => {
      error = e.code ?? "error";
    });
    // the server closes a refused connection and ends an accepted one
    client.on("close", finish);
    setTimeout(() => {
      client.destroy();
      finish();
    }, 2_000);
  });
}

describe("ticket issuance on a client-auth server", () => {
  test(
    "no ticket is issued, and no session authenticates another connection",
    { timeout: 120_000 },
    async () => {
      const key = createHash("sha256")
        .update(fixture)
        .update(readFileSync(fixture))
        .update("plain")
        .digest("hex")
        .slice(0, 16);
      const outDir = join(cacheDir, `tls-ticket-client-auth-${key}`);
      mkdirSync(outDir, { recursive: true });
      const result = await compile(fixture, {
        outPath: join(outDir, "program"),
        outDir,
        backend: "llvm",
      });
      if (!result.ok) {
        throw new Error(
          "program failed to compile:\n" +
            result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
        );
      }
      const server = spawn(result.binaryPath, [], { stdio: ["ignore", "pipe", "pipe"] });
      const stdout: string[] = [];
      let port: number | null = null;
      server.stdout.on("data", (c: Buffer) => stdout.push(c.toString("utf8")));
      const closed = new Promise<void>((resolve) => server.on("close", () => resolve()));
      await new Promise<void>((resolve, reject) => {
        let err = "";
        server.stderr.on("data", (c: Buffer) => {
          err += c.toString("utf8");
          const m = /^PORT (\d+)$/m.exec(err);
          if (m && port === null) {
            port = Number(m[1]);
            resolve();
          }
        });
        setTimeout(() => reject(new Error(`no PORT line: ${err}`)), 20_000);
      });
      const first = await firstConnection(port!);
      const certless = await attempt(port!, "localhost", first.session, false);
      await attempt(port!, "other.localhost", first.session, true);
      await closed;
      const out = stdout.join("");
      // the certificate-verified connection is secure …
      expect(first.ticketAtConnect).toBe("undefined");
      // … and carries no ticket to resume with
      expect(first.sessionEvents).toBe(0);
      // offering the exported session without a certificate is not authenticated
      expect(certless.error).not.toBeNull();
      // offering it to the context that trusts another ca is a full
      // handshake that the server refuses: one secure connection, no more
      expect(out.match(/^secure /gm)).toHaveLength(1);
      expect(out).toContain("secure 1 localhost true null");
      expect(out).not.toContain("secure 2");
      expect(out).toContain("tlsClientError");
      expect(out).toContain("closed");
    },
  );
});
