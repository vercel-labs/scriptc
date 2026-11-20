/* module.findPackageJSON resolved at build time, against Node's own answer as
 * the oracle: the resolver must answer the same path Node answers and refuse
 * exactly the cases where Node throws. The tree mirrors the shapes the
 * documentation uses (a project with a self-referencing package, a nested
 * package in node_modules, a hoisted one and a directory with no package.json
 * above it). */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findPackageJSON } from "node:module";
import { expect, test } from "vitest";
import { findPackageJson } from "../src/frontend/find-package-json.js";

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function tree(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "scriptc-find-package-json-"));
  write(join(root, "project/package.json"), '{"name":"@foo","exports":{"./x":"./x.js"}}');
  write(
    join(root, "project/packages/bar/package.json"),
    '{"name":"@foo/bar","exports":{".":"./index.js"}}',
  );
  write(join(root, "project/packages/bar/index.js"), "");
  write(join(root, "project/packages/bar/src/deep/file.js"), "");
  write(join(root, "project/packages/bar/emptydir/.keep"), "");
  write(
    join(root, "project/packages/bar/node_modules/some-package/package.json"),
    '{"name":"some-package","exports":{".":"./index.js"}}',
  );
  write(join(root, "project/packages/bar/node_modules/some-package/index.js"), "");
  write(
    join(root, "project/packages/bar/node_modules/some-package/sub/package.json"),
    '{"name":"some-package"}',
  );
  write(join(root, "project/node_modules/hoisted/package.json"), '{"name":"hoisted"}');
  write(join(root, "project/node_modules/@foo/bar/package.json"), '{"name":"@foo/bar"}');
  write(join(root, "project/packages/nully/package.json"), '{"name":"@foo/bar","exports":null}');
  write(join(root, "project/packages/nully/index.js"), "");
  write(join(root, "project/packages/bar/node_modules/broken/package.json"), "{bad json");
  write(join(root, "project/packages/bar/node_modules/broken/lib/x.js"), "");
  write(join(root, "project/packages/bar/node_modules/plain/lib/x.js"), "");
  write(join(root, "outside/deep/file.js"), "");
  symlinkSync(join(root, "project/packages/bar"), join(root, "linkbar"));
  return { root, base: join(root, "project/packages/bar/index.js") };
}

function oracle(
  specifier: string,
  base: string | undefined,
): { ok: true; path: string } | { ok: false } {
  try {
    const answer = findPackageJSON(specifier, base === undefined ? undefined : pathToFileURL(base));
    return answer === undefined ? { ok: false } : { ok: true, path: answer };
  } catch {
    return { ok: false };
  }
}

test("answers what Node's findPackageJSON answers", () => {
  const { root, base } = tree();
  const baseHref = pathToFileURL(base).href;
  const cases: [string, string | undefined][] = [
    ["@foo/bar", base],
    ["@foo/bar/nope", base],
    ["some-package", base],
    ["hoisted", base],
    ["missing-package", base],
    ["./src/deep/file.js", base],
    ["./src/deep/file", base],
    ["./emptydir", base],
    ["./emptydir/", base],
    ["../bar", base],
    ["../bar/", base],
    ["./nope.js", base],
    ["..", base],
    [".", base],
    ["/tmp", base],
    ["file:///tmp", base],
    [`${pathToFileURL(join(root, "project/packages/bar/index.js")).href}?q=1`, base],
    ["file:///tmp", undefined],
    ["data:text/javascript,1", base],
    // A package with "exports": null is not a self-reference; the installed
    // package of that name answers instead.
    ["@foo/bar", join(root, "project/packages/nully/index.js")],
    // A malformed nearest package.json and a target under node_modules with
    // no package.json of its own.
    ["./lib/x.js", join(root, "project/packages/bar/node_modules/plain/x.js")],
    ["@foo", base],
    ["%2f", base],
  ];
  for (const [specifier, caseBase] of cases) {
    const expected = oracle(specifier, caseBase);
    const actual = findPackageJson(
      specifier,
      caseBase === undefined ? "data:" : pathToFileURL(caseBase).href,
    );
    expect(actual.ok, specifier).toBe(expected.ok);
    if (actual.ok && expected.ok) expect(actual.path, specifier).toBe(expected.path);
  }
  expect(findPackageJson("@foo/bar", baseHref)).toEqual({
    ok: true,
    path: join(root, "project/packages/bar/package.json"),
  });
  // A malformed nearest package.json is Node's ERR_INVALID_PACKAGE_CONFIG.
  const broken = join(root, "project/packages/bar/node_modules/broken/lib/x.js");
  expect(findPackageJson(broken, baseHref)).toEqual({
    ok: false,
    refusal: expect.stringContaining(
      `Invalid package config ${join(root, "project/packages/bar/node_modules/broken/package.json")}.`,
    ),
  });
  expect(findPackageJson("anything", pathToFileURL(broken).href).ok).toBe(false);
  // A bare lookup from inside a package with no package.json of its own
  // walks no further than the node_modules boundary.
  const plain = join(root, "project/packages/bar/node_modules/plain/lib/x.js");
  expect(findPackageJson(plain, baseHref)).toEqual({ ok: true, path: plain });
});

test("a base that is not static or not a file: URL is refused", () => {
  expect(findPackageJson("some-package", "data:").ok).toBe(false);
  expect(findPackageJson(".", "relative/path").ok).toBe(false);
});
