import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { hostLibnodeTarget, libnodePackPackage } from "../src/node-islands/libnode-pack.js";

/* SC8005 when no pack can be found: the build names the module and the
 * @scriptc/node API that reach into Node (so a program can avoid the island),
 * and how to get this host's pack. */
const repoRoot = join(import.meta.dirname, "../..");
const dir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-pack-hint");

test("SC8005 points at the use and at the install line for this host", async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "island.cjs"), 'exports.answer = () => "native";\n');
  const entry = join(dir, "main.ts");
  writeFileSync(
    entry,
    'import { callSync } from "@scriptc/node";\nconsole.log(callSync("./island.cjs", "answer"));\n',
  );
  let result: Awaited<ReturnType<typeof compile>>;
  try {
    result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "main"),
      libnode: join(dir, "absent-pack"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (result.ok) throw new Error("expected the build to fail without a libnode pack");
  const diag = result.diagnostics.find((d) => d.code === "SC8005");
  expect(diag?.hint).toContain("main.ts uses callSync (@scriptc/node)");
  const pack = libnodePackPackage(hostLibnodeTarget());
  if (pack === null) expect(diag?.hint).toContain("packages/libnode-common/build-pack.mjs");
  else expect(diag?.hint).toContain(`npm i ${pack}@`);
});
