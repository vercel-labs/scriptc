import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { probeNodeFileImportRefusal } from "./npm.js";

// probeNodeFileImportRefusal against Node itself: for each specifier, Node's
// import() from the same importer either rejects with ERR_MODULE_NOT_FOUND,
// whose code, message and url the probe must reproduce, or does something
// else (loads, or refuses with another error), where the probe answers null.
// Node runs in an empty directory: it resolves a relative specifier's
// "Did you mean" hint against its working directory, so there it adds none.
test("relative and absolute import() refusals match Node's", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-file-import-")));
  writeFileSync(join(dir, "has space.mjs"), "export {};\n");
  writeFileSync(join(dir, "plain.mjs"), "export {};\n");
  writeFileSync(join(dir, "lit%20pct.mjs"), "export {};\n");
  writeFileSync(join(dir, "helper.js"), "export {};\n");
  mkdirSync(join(dir, "sub dir"));
  mkdirSync(join(dir, "pkgdir"));
  writeFileSync(join(dir, "pkgdir/package.json"), JSON.stringify({ main: "entry" }));
  writeFileSync(join(dir, "pkgdir/entry.js"), "export {};\n");
  mkdirSync(join(dir, "indexed"));
  writeFileSync(join(dir, "indexed/index.json"), "{}\n");
  mkdirSync(join(dir, "empty"));
  const importer = join(dir, "main.mjs");
  writeFileSync(
    importer,
    `const results = [];
for (const specifier of JSON.parse(process.argv[2])) {
  try {
    await import(specifier);
    results.push(null);
  } catch (error) {
    results.push(error.code === "ERR_MODULE_NOT_FOUND" ? { code: error.code, message: error.message, url: error.url } : null);
  }
}
process.stdout.write(JSON.stringify(results));
`,
  );
  const specifiers = [
    "./no-such-file.mjs",
    "./no%20such.mjs",
    "./has%20space.mjs",
    "./has space.mjs",
    "./lit%20pct.mjs",
    "./lit%2520pct.mjs",
    "./plain.mjs?x=1",
    "./plain.mjs#frag",
    "./missing.mjs?x=1",
    "./missing.mjs#frag",
    "./sub%2Fx.mjs",
    "./sub%5Cx.mjs",
    "./bad%zz.mjs",
    "./sub dir/",
    "./no-such-dir/",
    "./helper",
    "./pkgdir",
    "./pkgdir/",
    "./indexed",
    `../${basename(dir)}/missing.mjs`,
    `../${basename(dir)}/helper`,
    `${dir}/nope.mjs#h`,
    `${dir}/has%20space.mjs`,
    `${dir}/helper`,
    `${dir}/helper?q`,
    `${dir}/pkgdir/entry`,
    `${dir}/lit%20pct.mjs`,
    `${dir}/no-such`,
    `${dir}/indexed/`,
  ];
  const node = JSON.parse(
    execFileSync(process.execPath, [importer, JSON.stringify(specifiers)], {
      cwd: join(dir, "empty"),
      encoding: "utf8",
    }),
  ) as unknown[];
  const probed = specifiers.map((specifier) => probeNodeFileImportRefusal(importer, specifier));
  expect(Object.fromEntries(specifiers.map((s, i) => [s, probed[i]]))).toEqual(
    Object.fromEntries(specifiers.map((s, i) => [s, node[i]])),
  );
});
