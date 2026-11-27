/* DSA import limits: parameters are validated as the key is read, before
 * any arithmetic runs, so a malformed key cannot make signing or
 * verification unbounded work. The program reads keys whose DER is a few
 * kilobytes or tens of kilobytes of absurd parameters (a 64-bit-kilobit
 * divisor, a 64-kibibyte modulus) and must answer OpenSSL's
 * bad-ffc-parameters error quickly; the valid key below it pins that the
 * validation accepts what this runtime generates, including the derived
 * public half of an imported private key. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");

const PROGRAM = `import * as crypto from "node:crypto";

// DER lengths and a DSA SubjectPublicKeyInfo over four INTEGERs.
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}
function tlv(tag, body) {
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}
function derInt(bytes) {
  let start = 0;
  while (start + 1 < bytes.length && bytes[start] === 0) start++;
  let body = bytes.subarray(start);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}
const idDsa = Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x38, 0x04, 0x01]);
function spki(p, q, g, y) {
  return tlv(0x30, Buffer.concat([
    tlv(0x30, Buffer.concat([tlv(0x06, idDsa), tlv(0x30, Buffer.concat([derInt(p), derInt(q), derInt(g)]))])),
    tlv(0x03, Buffer.concat([Buffer.from([0]), derInt(y)])),
  ]));
}
function bytes(n) {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = (i * 37 + 11) & 0xff;
  out[0] |= 0x80;
  out[n - 1] |= 1;
  return out;
}

function attempt(label, der, privateKey) {
  const start = Date.now();
  try {
    const key = privateKey
      ? crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" })
      : crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    console.log(label, "ok", key.asymmetricKeyType, true);
  } catch (error) {
    console.log(label, error.name, error.code ?? "-", error.message, Date.now() - start < 1000);
  }
}

const p = bytes(128);
const g = Buffer.from([2]);
const y = bytes(128);
// A 65536-bit divisor, and a 64-kibibyte modulus.
attempt("huge q", spki(p, bytes(8192), g, y));
attempt("huge p", spki(bytes(8192), bytes(32), g, y));
// A 512-bit divisor is outside the FIPS 186-4 sizes too.
attempt("q 512", spki(p, bytes(64), g, y));

// The keys this runtime makes pass the same validation on the way back in,
// and an imported private key verifies its own signature.
const pair = crypto.generateKeyPairSync("dsa", { modulusLength: 1024, divisorLength: 160 });
const spkiDer = pair.publicKey.export({ format: "der", type: "spki" });
const pkcs8Der = pair.privateKey.export({ format: "der", type: "pkcs8" });
attempt("reimport public", spkiDer);
attempt("reimport private", pkcs8Der, true);
const back = crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
const signature = crypto.sign("sha256", Buffer.from("hello"), back);
console.log("imported private verifies", crypto.verify("sha256", Buffer.from("hello"), back, signature));
`;

test("DSA import validates its parameters before any arithmetic", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-dsa-limits-"));
  try {
    const entry = join(dir, "main.mjs");
    const binary = join(dir, "main");
    writeFileSync(entry, PROGRAM);
    await execFileAsync(process.execPath, [cli, "build", entry, "-o", binary], {
      env: { ...process.env, SCRIPTC_NO_CACHE: "1" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    const started = Date.now();
    const run = await execFileAsync(binary, [], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      [
        "huge q Error - error:05000072:dsa routines::bad ffc parameters true",
        "huge p Error - error:05000072:dsa routines::bad ffc parameters true",
        "q 512 Error - error:05000072:dsa routines::bad ffc parameters true",
        "reimport public ok dsa true",
        "reimport private ok dsa true",
        "imported private verifies true",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
