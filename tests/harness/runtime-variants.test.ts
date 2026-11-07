/** A program links, for each runtime unit, the one build whose conditions
 * name exactly the features the program has among those the unit's builds
 * are keyed on (selectRuntimeVariant). A unit keyed on N features therefore
 * needs a build for every combination of them, and each matrix lists those
 * by hand. These tests make that list a checked invariant: every combination
 * a program can ask for selects a build, the build carries each feature's
 * defines, and every feature a build is keyed on is one the compiler
 * computes. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import {
  evaluateRuntimePredicate,
  selectRuntimeVariant,
  type RuntimePredicate,
} from "../../packages/compiler/src/backend/runtime-pack-core.js";
import { RUNTIME_PACK_MATRIX } from "../../packages/runtime-darwin-arm64/runtime-pack-matrix.mjs";
import { createRuntimePackMatrix } from "../../packages/runtime-pack-common/runtime-pack-matrix.mjs";

interface Variant {
  id: string;
  when: Record<string, boolean>;
  defines: string[];
}
interface Unit {
  source: string;
  predicate: RuntimePredicate;
  variants: Variant[];
}
interface Matrix {
  target: { object_format: string };
  runtime_units: Unit[];
  flavors: Record<string, { runtime_units?: Unit[] }>;
}

const root = join(import.meta.dirname, "../..");

/** Every matrix a pack is built from: the shared one per object format, its
 * library-only form (the mobile packs), and the macOS pack's own. */
const MATRICES: [string, Matrix][] = [
  ...["elf", "macho", "coff", "wasm"].flatMap((object_format): [string, Matrix][] => [
    [
      object_format,
      createRuntimePackMatrix({ target: { object_format }, compileFlags: [], systemLibraries: [] }),
    ],
    [
      `${object_format}, library only`,
      createRuntimePackMatrix({
        target: { object_format },
        compileFlags: [],
        systemLibraries: [],
        libraryOnly: true,
      }),
    ],
  ]),
  ["macos-arm64", RUNTIME_PACK_MATRIX],
];

/** The unit lists of a matrix by the flavors that link them: the executable
 * flavors share the matrix's own list, and each library flavor has its own. */
function unitLists(matrix: Matrix): { flavor: string; executable: boolean; units: Unit[] }[] {
  const lists: { flavor: string; executable: boolean; units: Unit[] }[] = [];
  for (const [flavor, spec] of Object.entries(matrix.flavors)) {
    lists.push(
      spec.runtime_units === undefined
        ? { flavor, executable: true, units: matrix.runtime_units }
        : { flavor, executable: false, units: spec.runtime_units },
    );
  }
  return lists;
}

function keyedFeatures(unit: Unit): string[] {
  return [...new Set(unit.variants.flatMap((variant) => Object.keys(variant.when)))].sort();
}

/** The features that decide whether a program links the unit at all. */
function predicateFeatures(predicate: RuntimePredicate): string[] {
  if (typeof predicate === "boolean") return [];
  if (typeof predicate === "string") return [predicate];
  return [...(predicate.all ?? []), ...(predicate.any ?? []), ...(predicate.not ?? [])];
}

/** The names a variant's conditions turn on, as one sorted key. */
function named(variant: Variant): string {
  return Object.keys(variant.when)
    .filter((name) => variant.when[name])
    .sort()
    .join("+");
}

test.each(MATRICES)(
  "every feature combination selects one build of every unit (%s)",
  (_name, matrix) => {
    let checked = 0;
    for (const { flavor, executable, units } of unitLists(matrix)) {
      // Worker threads need a native static executable: the compiler refuses
      // them for a library and for wasm before it selects anything
      // (selectRuntimePackArtifacts), so those flavors build no worker
      // variant and no program asks them for one.
      const workerBuilds = units.some((unit) =>
        unit.variants.some((variant) => variant.when["workers"] === true),
      );
      expect(workerBuilds, flavor).toBe(executable && matrix.target.object_format !== "wasm");
      for (const unit of units) {
        const keyed = keyedFeatures(unit);
        const byName = new Map(unit.variants.map((variant) => [named(variant), variant]));
        const names = [...new Set([...keyed, ...predicateFeatures(unit.predicate)])].sort();
        // Every assignment of the features that select the unit or one of
        // its builds, as the names that are on.
        for (let mask = 0; mask < 1 << names.length; mask++) {
          const on = names.filter((_, index) => (mask & (1 << index)) !== 0);
          if (!workerBuilds && on.includes("workers")) continue;
          const features = Object.fromEntries(names.map((name) => [name, on.includes(name)]));
          // A program without the unit's own features links none of it.
          if (!evaluateRuntimePredicate(unit.predicate, features)) continue;
          const label = `${flavor} ${unit.source} with ${on.join("+") || "no feature"}`;
          let variant: Variant | undefined;
          expect(() => {
            variant = selectRuntimeVariant(unit, features);
          }, label).not.toThrow();
          const wanted = on.filter((name) => keyed.includes(name));
          expect(named(variant!), label).toBe(wanted.join("+"));
          // A build carries the defines of each feature it names and no
          // other: the build for one feature alone says which those are.
          const alone = wanted.map((name) => byName.get(name));
          if (alone.every((single) => single !== undefined)) {
            const expected = new Set([
              ...(byName.get("")?.defines ?? []),
              ...alone.flatMap((single) => single!.defines),
            ]);
            expect([...variant!.defines].sort(), label).toEqual([...expected].sort());
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  },
);

test("a missing combination fails the build by name", () => {
  const unit: Unit = {
    source: "scr_example.c",
    variants: [
      { id: "default", when: {}, defines: [] },
      { id: "first", when: { first: true }, defines: ["SCR_FIRST"] },
      { id: "second", when: { second: true }, defines: ["SCR_SECOND"] },
    ],
  };
  expect(selectRuntimeVariant(unit, { first: true }).id).toBe("first");
  expect(selectRuntimeVariant(unit, { second: true, other: true }).id).toBe("second");
  expect(selectRuntimeVariant(unit, {}).id).toBe("default");
  // Neither single-feature build carries both defines, so neither is linked.
  expect(() => selectRuntimeVariant(unit, { first: true, second: true })).toThrow(
    "runtime pack has no build of scr_example.c for this program's features: the unit's builds are keyed on first, second, the program has first, second, and exactly one variant must name exactly those (the pack builds default, first, second)",
  );
  // Two builds for one combination are as ambiguous as none.
  unit.variants.push({ id: "again", when: { first: true, second: false }, defines: ["SCR_FIRST"] });
  expect(() => selectRuntimeVariant(unit, { first: true })).toThrow(
    "runtime pack has 2 builds (first, again) of scr_example.c",
  );
});

/** The member names of an interface declared in a compiler source file. */
function interfaceMembers(path: string, name: string): string[] {
  const file = ts.createSourceFile(
    path,
    readFileSync(join(root, path), "utf8"),
    ts.ScriptTarget.Latest,
  );
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  expect(declaration, `${name} in ${path}`).toBeDefined();
  return declaration!.members.map((member) => (member.name as ts.Identifier).text);
}

test("every feature a build is keyed on is one the compiler computes", () => {
  // A name no program can have would never select its build, and the
  // program would link the default one without a word.
  const known = new Set([
    ...interfaceMembers(
      "packages/compiler/src/backend/native-link-info-core.ts",
      "NativeLinkFeatures",
    ),
    ...interfaceMembers("packages/compiler/src/backend/runtime-pack-core.ts", "RuntimeFeatureSet"),
  ]);
  expect(known.has("nodeIsland")).toBe(true);
  for (const [name, matrix] of MATRICES) {
    for (const { flavor, units } of unitLists(matrix)) {
      for (const unit of units) {
        for (const feature of keyedFeatures(unit))
          expect(known.has(feature), `${name} ${flavor} ${unit.source}: ${feature}`).toBe(true);
      }
    }
  }
});
