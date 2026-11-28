/* Ed448 keys are neither created nor read: the bundled crypto library has
 * no Ed448, so every entry point refuses the Node-made key below. The
 * program pins each refusal's shape — generation is refused at compile time
 * (the audit test's ed448 line), and here the DER, JWK and raw imports of a
 * fixed Node-generated key. Node itself creates, imports and signs with
 * these keys, so this is a documented limitation, not an oracle case. */
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

const show = (label, f) => {
  try {
    console.log(label, "OK", f());
  } catch (error) {
    console.log(label, "THROW", error.name, error.code ?? "-",
      (error.message ?? "").replace(/ \\[SC2020 at .*\\]$/, ""));
  }
};

// A Node-generated Ed448 key: PKCS#8, SubjectPublicKeyInfo, both JWK forms
// and its 57-byte raw public key.
const PKCS8 = Buffer.from("3047020100300506032b6571043b04394ef8ee2f42777a11ddb8e28728482404a14e62d8b2d2d81d6c20b2cd3bb9cab1f9066c04b434def24e4e6cb522f722859f7243bb52badb04ae", "hex");
const SPKI = Buffer.from("3043300506032b6571033a003d1fe73cead7af48c71394a1ead7edb376dc130b3f080c658b823b27e86f5ec28b68cf8ce067ee3eecccca941bf381a2794bccda22d1d24100", "hex");
const JWK_PRIVATE = {
  kty: "OKP",
  crv: "Ed448",
  x: "PR_nPOrXr0jHE5Sh6tfts3bcEws_CAxli4I7J-hvXsKLaM-M4GfuPuzMypQb84GieUvM2iLR0kEA",
  d: "TvjuL0J3ehHduOKHKEgkBKFOYtiy0tgdbCCyzTu5yrH5BmwEtDTe8k5ObLUi9yKFn3JDu1K62wSu",
};
const JWK_PUBLIC = {
  kty: "OKP",
  crv: "Ed448",
  x: "PR_nPOrXr0jHE5Sh6tfts3bcEws_CAxli4I7J-hvXsKLaM-M4GfuPuzMypQb84GieUvM2iLR0kEA",
};
const RAW = Buffer.from("3d1fe73cead7af48c71394a1ead7edb376dc130b3f080c658b823b27e86f5ec28b68cf8ce067ee3eecccca941bf381a2794bccda22d1d24100", "hex");

show("pkcs8", () => crypto.createPrivateKey({ key: PKCS8, format: "der", type: "pkcs8" }).asymmetricKeyType);
show("spki", () => crypto.createPublicKey({ key: SPKI, format: "der", type: "spki" }).asymmetricKeyType);
show("jwk private", () => crypto.createPrivateKey({ key: JWK_PRIVATE, format: "jwk" }).asymmetricKeyType);
show("jwk public", () => crypto.createPublicKey({ key: JWK_PUBLIC, format: "jwk" }).asymmetricKeyType);
show("raw public", () =>
  crypto.createPublicKey({ key: RAW, format: "raw-public", asymmetricKeyType: "ed448" }).asymmetricKeyType);
`;

test("Ed448 keys are refused at every import entry point", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-ed448-refusals-"));
  try {
    const entry = join(dir, "main.mjs");
    const binary = join(dir, "main");
    writeFileSync(entry, PROGRAM);
    await execFileAsync(process.execPath, [cli, "build", entry, "-o", binary], {
      env: { ...process.env, SCRIPTC_NO_CACHE: "1" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    const run = await execFileAsync(binary, [], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20_000,
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      [
        "pkcs8 THROW Error ERR_OSSL_UNSUPPORTED error:1E08010C:DECODER routines::unsupported",
        "spki THROW Error ERR_OSSL_UNSUPPORTED error:1E08010C:DECODER routines::unsupported",
        "jwk private THROW TypeError ERR_CRYPTO_INVALID_JWK Invalid JWK OKP key",
        "jwk public THROW TypeError ERR_CRYPTO_INVALID_JWK Invalid JWK OKP key",
        "raw public THROW Error SC2020 'raw keys of this asymmetricKeyType' is part of the standard library types but has no scriptc lowering yet",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
