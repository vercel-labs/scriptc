// The TLS client's floor for a server's finite-field Diffie-Hellman group:
// Node refuses a group under 2048 bits ("dh key too small"), and so does a
// compiled client. A compiled server cannot offer a chosen group, so the
// two servers run here under Node, and the fixture client runs under Node
// and as a binary against both.
import { execFile } from "node:child_process";
import { getDiffieHellman } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as tls from "node:tls";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const suite = "DHE-RSA-AES128-GCM-SHA256";

/** DER length octets. */
function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** A DER INTEGER holding the unsigned big-endian `value`. */
function derInteger(value: Buffer): Buffer {
  const body = (value[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), value]) : value;
  return Buffer.concat([Buffer.from([0x02]), derLength(body.length), body]);
}

/** PKCS #3 DH parameters, in PEM, for one of Node's named MODP groups. */
function dhParameters(group: "modp2" | "modp14"): string {
  const dh = getDiffieHellman(group);
  const body = Buffer.concat([derInteger(dh.getPrime()), derInteger(dh.getGenerator())]);
  const der = Buffer.concat([Buffer.from([0x30]), derLength(body.length), body]);
  const lines = der
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n");
  return `-----BEGIN DH PARAMETERS-----\n${lines}\n-----END DH PARAMETERS-----\n`;
}

/** A server that offers only `suite` with `group`, and records the suite
 * of each connection it completes. */
async function dheServer(
  group: "modp2" | "modp14",
  completed: string[],
): Promise<{ port: number; close: () => Promise<void> }> {
  const certs = join(repoRoot, "tests/fixtures/server/certs");
  const server = tls.createServer(
    {
      // The suite authenticates with RSA, so the server presents the RSA leaf.
      cert: readFileSync(join(certs, "localhost-rsa.pem")),
      key: readFileSync(join(certs, "localhost-rsa-key.pem")),
      // The server's own security level would refuse to offer the small group.
      ciphers: `${suite}:@SECLEVEL=0`,
      dhparam: dhParameters(group),
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
    },
    (socket) => {
      completed.push(socket.getCipher().name);
      socket.on("error", () => {});
      socket.end();
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

test("a client refuses a 1024-bit Diffie-Hellman group and accepts a 2048-bit one, as Node does", async () => {
  const entry = join(repoRoot, "tests/fixtures/tls/dh-floor.ts");
  const outDir = join(cacheDir, `tls-dh-floor-${sanitize ? "san" : "plain"}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "dh-floor"),
    outDir,
    sanitize,
    backend: "llvm",
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const small: string[] = [];
  const large: string[] = [];
  const server1024 = await dheServer("modp2", small);
  const server2048 = await dheServer("modp14", large);
  try {
    const targets = [`1024-bit=${server1024.port}`, `2048-bit=${server2048.port}`];
    const native = await execFileAsync(result.binaryPath, targets, { cwd: repoRoot });
    const node = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", entry, ...targets],
      { cwd: repoRoot },
    );
    expect(node.stdout).toBe("1024-bit refused\n2048-bit connected\n");
    expect(native.stdout).toBe(node.stdout);
    // Both clients negotiated the finite-field suite with the large group,
    // and neither completed a handshake with the small one.
    expect(large).toEqual([suite, suite]);
    expect(small).toEqual([]);
  } finally {
    await server1024.close();
    await server2048.close();
  }
}, 120_000);
