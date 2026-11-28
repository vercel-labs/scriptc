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

/* The second shape of the same hazard: a key whose parameters are padded.
 * OpenSSL's decoder accepts the padding and Node imports such a key in
 * milliseconds, so the parameters are trimmed before they are sized; a
 * padding run the runtime refuses is one with an absurd encoding length.
 * The program imports a modestly padded key and signs and verifies with
 * it, then reads one whose modulus is behind 64 KiB of zeros. */
const PADDED_PROGRAM = `import * as crypto from "node:crypto";

const P = Buffer.from("d1eed29c118a64188d2813ffcb1bc458bc85e2b53a795399fcc27cc5a7585bf9293f6b92da9497c8e3fa362dd2fa6fb7cf65d16c1045eb7b8603fe91a78ebd97368afd80630bdbe37a6aedcf8e41ab1df33fd78ed8d718b2f48ab4bd7a3bfe1f0b1f90842df9f245e1c5d0223f8cd827b71c575429fca8d2d8688af9393d753f", "hex");
const Q = Buffer.from("806acbec3859ec75d98f24ab3bf30855d0022ddd", "hex");
const G = Buffer.from("6dc44ebbf0aec70cf50ff406370e2b3f8ac0f9a3f90deba4ed028a78ef31add5ae9e750f0a84dfa868c69c06129222938591c7dbd3368733dbe9160b02acfe52d3721f8499a157f1af32f67cf8bc829f7fe1c4348824db8375de357ba7171710f9c3f17572746e72974a5a630759a969e1139c2beb67af241ad15caa594d2478", "hex");
const X = Buffer.from("76b31c7ea502397c1e4b36ca9d734011c03970d7", "hex");

function derLen(n) {
  return n < 0x80 ? Buffer.from([n])
    : n < 0x100 ? Buffer.from([0x81, n])
      : n < 0x10000 ? Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff])
        : Buffer.from([0x83, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}
function tlv(tag, body) {
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}
function derInt(v, pad) {
  let body = v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v;
  if (pad > 0) body = Buffer.concat([Buffer.alloc(pad), body]);
  return tlv(0x02, body);
}
const dsaOid = Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x38, 0x04, 0x01]);
function pkcs8(pad) {
  const params = tlv(0x30, Buffer.concat([derInt(P, pad), derInt(Q, pad), derInt(G, pad)]));
  const alg = tlv(0x30, Buffer.concat([tlv(0x06, dsaOid), params]));
  return tlv(0x30, Buffer.concat([derInt(Buffer.from([0]), 0), alg,
    tlv(0x04, derInt(X, 0))]));
}

function attempt(label, der) {
  const start = Date.now();
  try {
    const key = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const message = Buffer.from("padded");
    const signature = crypto.sign("sha256", message, key);
    console.log(label, "ok", JSON.stringify(key.asymmetricKeyDetails),
      crypto.verify("sha256", message, crypto.createPublicKey(key), signature), true);
  } catch (error) {
    console.log(label, error.name, error.code ?? "-", error.message, Date.now() - start < 1000);
  }
}

attempt("padded params", pkcs8(40));
attempt("absurd params", pkcs8(65536));
`;

test("DSA parameter padding is trimmed before it is sized, and absurd runs are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-dsa-padded-"));
  try {
    const entry = join(dir, "main.mjs");
    const binary = join(dir, "main");
    writeFileSync(entry, PADDED_PROGRAM);
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
        'padded params ok {"modulusLength":1024,"divisorLength":160} true true',
        "absurd params Error - error:05000072:dsa routines::bad ffc parameters true",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
