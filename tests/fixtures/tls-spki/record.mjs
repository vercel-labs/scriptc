// Records tests/fixtures/tls-spki/expected/*.txt: main.ts's output under a
// Node release that carries the blocked-SPKI list (24.22.1 or newer), each
// run with one fixture public key injected through the same hook the harness
// uses. Run from the repository root with that Node:
//
//   /path/to/node-24.22.1/bin/node tests/fixtures/tls-spki/record.mjs
//
// The recordings are what tests/harness/tls-spki-blocklist.test.ts requires
// the compiled lane to print.
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dirname;
const root = join(dir, "../../..");
const digest = (name) =>
  createHash("sha256")
    .update(new X509Certificate(readFileSync(join(dir, `${name}.pem`))).publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");

const runs = [
  ["clean", ""],
  ["blocked-intermediate", digest("inter")],
  ["blocked-root", digest("root")],
  ["blocked-unrelated", digest("unrelated")],
  ["blocked-client", digest("client")],
];

mkdirSync(join(dir, "expected"), { recursive: true });
for (const [name, hex] of runs) {
  const r = spawnSync(
    process.execPath,
    ["--expose-internals", "--no-warnings", "--require", join(dir, "node-hook.cjs"), join(dir, "main.ts")],
    { cwd: root, encoding: "utf8", env: { ...process.env, SCRIPTC_TLS_BLOCKED_SPKI: hex } },
  );
  if (r.status !== 0) {
    console.error(`${name}: exit ${r.status}\n${r.stderr}`);
    process.exit(1);
  }
  writeFileSync(join(dir, "expected", `${name}.txt`), r.stdout);
  process.stdout.write(`# ${name} ${hex || "(none)"}\n${r.stdout}`);
}
