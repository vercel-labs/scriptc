/* Rotating a tls.Server's ticket keys invalidates the sessions minted under
 * the previous material: a client that offers such a session gets a full
 * handshake, while the ticket that handshake issues resumes as usual.
 * Native lane only — the client is Node's, whose isSessionReused() reports
 * the difference (this runtime's client has no resumption). */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as tls from "node:tls";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const fixture = join(repoRoot, "tests/fixtures/tls-ticket-keys-rotation/main.ts");
const certs = join(repoRoot, "tests/fixtures/server/certs");

interface Attempt {
  /* isSessionReused() at secureConnect */
  reused: boolean | null;
  /* the session the connection ended with, offered to the next one */
  session: Buffer | null;
}

function connect(port: number, session: Buffer | null): Promise<Attempt> {
  return new Promise((done) => {
    const ca = readFileSync(join(certs, "ca.pem"));
    const options: tls.ConnectionOptions = {
      port,
      host: "127.0.0.1",
      servername: "localhost",
      ca,
      maxVersion: "TLSv1.2",
    };
    if (session !== null) options.session = session;
    let reused: boolean | null = null;
    let captured: Buffer | null = null;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      done({ reused, session: captured });
    };
    const client = tls.connect(options);
    client.on("secureConnect", () => {
      reused = client.isSessionReused();
      captured = client.getSession();
    });
    client.on("session", (s: Buffer) => {
      captured = s;
    });
    client.on("data", () => {});
    client.on("error", () => {});
    // the server ends an accepted connection
    client.on("close", finish);
    setTimeout(() => client.end(), 250);
    setTimeout(() => {
      client.destroy();
      finish();
    }, 2_000);
  });
}

function waitForLine(lines: () => string, pattern: RegExp, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20_000;
    const tick = (): void => {
      if (pattern.test(lines())) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`no ${what} line: ${JSON.stringify(lines())}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("rotating a server's ticket keys", () => {
  test("a session from before the rotation no longer resumes", { timeout: 120_000 }, async () => {
    const key = createHash("sha256")
      .update(fixture)
      .update(readFileSync(fixture))
      .update("plain")
      .digest("hex")
      .slice(0, 16);
    const outDir = join(cacheDir, `tls-ticket-keys-rotation-${key}`);
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
    const out = (): string => stdout.join("");
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
    // the first connection's session is minted under the initial keys
    const first = await connect(port!, null);
    expect(first.reused).toBe(false);
    expect(first.session).not.toBeNull();
    // the server rotates once, after that connection closed
    await waitForLine(out, /^rotated true installed true$/m, "rotation");
    // the pre-rotation session is a full handshake now
    const second = await connect(port!, first.session);
    expect(second.reused).toBe(false);
    expect(second.session).not.toBeNull();
    // and the session that handshake issued resumes
    const third = await connect(port!, second.session);
    expect(third.reused).toBe(true);
    await closed;
    expect(out()).toContain("secure 3");
    expect(out()).toContain("closed");
  });
});
