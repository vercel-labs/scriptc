/** A runtime unit is compiled once per build the matrix lists for it, each
 * with that build's defines and no other. A unit whose source tests a build
 * define the matrix never builds it with therefore always compiles the
 * other arm in a pack, whatever the program: the code under the define is
 * dead there, and a program that needs it links a unit without it. The
 * source build passes a program's defines to every unit, so the two would
 * also disagree. These tests keep the sources and the matrix in step. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { noLinkFeatures } from "../../packages/compiler/src/backend/native-link-info-core.js";
import {
  effectiveRuntimeFeatures,
  evaluateRuntimePredicate,
  type RuntimePredicate,
} from "../../packages/compiler/src/backend/runtime-pack-core.js";
import {
  BASE_RUNTIME_SOURCES,
  OPTIONAL_RUNTIME_SOURCES,
  variantsFor,
} from "../../packages/runtime-pack-common/runtime-pack-matrix.mjs";

const sourceDir = join(import.meta.dirname, "../../packages/runtime/src");
const sources: string[] = [
  ...BASE_RUNTIME_SOURCES,
  ...OPTIONAL_RUNTIME_SOURCES.map(([source]: [string, unknown]) => source),
];

/** The defines each unit is built with in some variant. */
const builtWith = new Map(
  sources.map((source) => [
    source,
    new Set<string>(
      variantsFor(source).flatMap((variant: { defines: string[] }) => variant.defines),
    ),
  ]),
);
/** Every define that selects a build of some unit. */
const buildDefines = [...new Set([...builtWith.values()].flatMap((defines) => [...defines]))];

/** The text with comments blanked, line structure kept. */
function code(path: string): string {
  return readFileSync(join(sourceDir, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

const conditional = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/;
const names = (define: string): RegExp => new RegExp(`\\b${define}\\b`);

/** The macros a header defines inside a conditional on a build define: a
 * unit that uses one compiles differently with and without the define. */
function headerMacros(): Map<string, { define: string; header: string }> {
  const macros = new Map<string, { define: string; header: string }>();
  for (const header of readdirSync(sourceDir).filter((name) => name.endsWith(".h"))) {
    const open: (string | null)[] = [];
    for (const line of code(header).split("\n")) {
      const match = conditional.exec(line);
      if (match !== null) {
        const [, keyword, rest] = match;
        if (keyword === "if" || keyword === "ifdef" || keyword === "ifndef")
          open.push(buildDefines.find((define) => names(define).test(rest!)) ?? null);
        else if (keyword === "endif") open.pop();
        continue;
      }
      const define = open.find((entry) => entry !== null);
      const macro = /^\s*#\s*define\s+(\w+)/.exec(line);
      if (define != null && macro !== null) macros.set(macro[1]!, { define, header });
    }
  }
  return macros;
}

test("a unit tests a build define only when the matrix builds it with that define", () => {
  const macros = headerMacros();
  // The scan sees the macros it is meant to: an array's length under the
  // JavaScript object model build.
  expect(macros.get("scr_dyn_arr_length")?.define).toBe("SCR_JS_OBJECT_MODEL");
  const unbuilt: string[] = [];
  for (const source of sources) {
    const text = code(source);
    const built = builtWith.get(source)!;
    for (const line of text.split("\n")) {
      const match = conditional.exec(line);
      if (match === null || match[1] === "else" || match[1] === "endif") continue;
      for (const define of buildDefines) {
        if (names(define).test(match[2]!) && !built.has(define))
          unbuilt.push(`${source} tests ${define}`);
      }
    }
    for (const [macro, { define, header }] of macros) {
      if (!built.has(define) && names(macro).test(text))
        unbuilt.push(
          `${source} uses ${macro}, which ${header} defines differently under ${define}`,
        );
    }
  }
  // Each entry is a unit the pack never compiles with the define it tests:
  // give it that build in runtime-pack-matrix.mjs, or reach the feature
  // through a table its unit installs instead of a define.
  expect([...new Set(unbuilt)]).toEqual([]);
});

test("the map unit's promise-key build is selected exactly when the dynamic promise unit is linked", () => {
  // Only scr_async_dyn.c makes a promise adapter: a second box of one promise
  // at another address. scr_map.c keys a boxed promise by the identity the
  // adapters share only in its SCR_DYN_PROMISE_KEYS build, so a program that
  // linked the unit with the default map object would store a promise as a
  // key and never find it again, without any error. The unit's predicate is
  // written in the matrix and the build's feature (dynPromiseKeys) in the
  // compiler: this holds the two to each other, one link feature at a time.
  const unit = (OPTIONAL_RUNTIME_SOURCES as [string, RuntimePredicate][]).find(
    ([source]) => source === "scr_async_dyn.c",
  );
  expect(unit).toBeDefined();
  const predicate = unit![1];
  const builds: { id: string; when: Record<string, boolean>; defines: string[] }[] =
    variantsFor("scr_map.c");
  const keyed = builds.filter((build) => build.defines.includes("SCR_DYN_PROMISE_KEYS"));
  expect(keyed.length).toBeGreaterThan(0);
  for (const build of builds)
    expect(build.when.dynPromiseKeys === true, build.id).toBe(
      build.defines.includes("SCR_DYN_PROMISE_KEYS"),
    );
  const off = effectiveRuntimeFeatures(noLinkFeatures(), {});
  expect(evaluateRuntimePredicate(predicate, off)).toBe(false);
  expect(off.dynPromiseKeys).toBe(false);
  // Every name the runtime feature set has is tried as a link feature; a
  // computed name is no link feature and leaves the set as it was.
  const linking: string[] = [];
  for (const feature of Object.keys(off)) {
    const on = effectiveRuntimeFeatures({ ...noLinkFeatures(), [feature]: true }, {});
    const linked = evaluateRuntimePredicate(predicate, on);
    expect(on.dynPromiseKeys, `a program with ${feature}`).toBe(linked);
    if (linked) linking.push(feature);
  }
  // The loop reached every way the matrix links the unit.
  const ways = typeof predicate === "object" ? (predicate.any ?? []) : [];
  expect(ways.length).toBeGreaterThan(0);
  expect(linking.length).toBeGreaterThanOrEqual(ways.length);
});
