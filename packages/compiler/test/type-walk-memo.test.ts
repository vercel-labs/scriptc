// One mapping of a type maps each type it reaches once (the walk memo of
// frontend/type-mapper.ts). Before it, a mapping walked a nested type once
// for every path that reached it: a chain of records that each name the next
// in two members cost 2^depth, in the strict mapping and again in the lenient
// mapping of a declaration whose type holds a member with no static lowering.
// These programs are generated type graphs (a parts catalogue): the builds
// must end within seconds at sizes that used to take hours, the memo must not
// change what a build produces, and a mapping the memo cannot shorten must
// end the build with SC2016 instead of running on.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { compile, type TierMode } from "../src/index.js";
import { configureTypeWalk } from "../src/frontend/type-mapper.js";

type Shape =
  | "chain"
  | "lattice"
  | "ring"
  | "mesh"
  | "methods"
  | "generic"
  | "arrays"
  | "stacks"
  | "stackring"
  | "stackmesh";
type Blocker = "root" | "deep" | "none";

const SLOTS = ["left", "right", "third"];
const BLOCKED_MEMBER = "  bins: WeakSet<object> | Set<object> | null;";
/** The "stack" shapes name the next record through seven map types, so a
 * path of nine records is as deep as the mapping goes (64 frames): the walk
 * without the memo still ends, and what the memo keeps about the depth limit
 * is compared with it. */
const stacked = (type: string): string => "Map<string, ".repeat(7) + type + ">".repeat(7);

/** A module global whose declared type reaches `n` record types. `fan` is the
 * number of members of each record that name other records. With a blocker
 * the type has one member with no static lowering, in the root type or in
 * the last record, so the declaration's type is mapped leniently as well. */
function catalogue(shape: Shape, n: number, fan: number, blocker: Blocker): string {
  const out: string[] = [];
  const tier = (i: number): string => `Tier${i}`;
  const close = (last: boolean): void => {
    if (blocker === "deep" && last) out.push(BLOCKED_MEMBER);
    out.push("}");
  };
  if (shape === "lattice") {
    for (let i = 0; i < n; i++) {
      for (const side of ["A", "B"]) {
        out.push(`interface ${tier(i)}${side} {`, `  weight${i}${side}: number;`);
        if (i + 1 < n)
          out.push(`  left: ${tier(i + 1)}A | null;`, `  right: ${tier(i + 1)}B | null;`);
        close(i === n - 1 && side === "B");
      }
    }
    out.push(`type ${tier(0)} = ${tier(0)}A | ${tier(0)}B;`);
  } else if (shape === "mesh" || shape === "stackmesh") {
    for (let i = 0; i < n; i++) {
      out.push(`interface ${tier(i)} {`, `  weight${i}: number;`);
      for (let f = 1; f <= Math.min(fan, n - 1); f++)
        out.push(
          shape === "mesh"
            ? `  link${f}: ${tier((i + f) % n)} | null;`
            : `  link${f}: ${stacked(tier((i + f) % n))};`,
        );
      close(i === n - 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      out.push(`interface ${tier(i)} {`, `  weight${i}: number;`);
      const closes = shape === "ring" || shape === "stackring";
      const next = i + 1 < n ? tier(i + 1) : closes ? tier(0) : null;
      if (next !== null)
        for (let f = 0; f < fan; f++) {
          const slot = SLOTS[f]!;
          if (shape === "methods") out.push(`  ${slot}(part: ${next}): ${next} | null;`);
          else if (shape === "generic") out.push(`  ${slot}<T>(part: ${next}, tag: T): T;`);
          else if (shape === "arrays")
            out.push(f % 2 === 0 ? `  ${slot}: ${next}[];` : `  ${slot}: Map<string, ${next}>;`);
          else if (shape === "stacks" || shape === "stackring")
            out.push(`  ${slot}: ${stacked(next)};`);
          else out.push(`  ${slot}: ${next} | null;`);
        }
      close(i === n - 1);
    }
  }
  out.push(
    "type Catalogue = {",
    `  root: ${tier(0)} | null;`,
    blocker === "root" ? BLOCKED_MEMBER : "  bins: Set<object> | null;",
    "  count: number;",
    "};",
    `const catalogue: Catalogue = { root: null, bins: null, count: ${n} };`,
    "console.log(catalogue.root === null, catalogue.bins === null, catalogue.count);",
  );
  return out.join("\n");
}

interface Lowered {
  ok: boolean;
  ir: string;
  errors: string[];
  warnings: string[];
  /** Where each error points: the offset in the source. */
  errorOffsets: number[];
  seconds: number;
}

async function lower(source: string, tier?: TierMode): Promise<Lowered> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-type-walk-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const started = performance.now();
    const result = await compile(entry, {
      outDir: dir,
      outPath,
      outputKind: "ir",
      ...(tier === undefined ? {} : { tier }),
    });
    const seconds = (performance.now() - started) / 1000;
    const text = (d: { code: string; message: string }): string => `${d.code}: ${d.message}`;
    if (!result.ok)
      return {
        ok: false,
        ir: "",
        errors: result.diagnostics.map(text),
        warnings: [],
        errorOffsets: result.diagnostics.map((d) => d.loc.start),
        seconds,
      };
    return {
      ok: true,
      // The module names its source file, and every lowering has its own
      // directory.
      ir: (await readFile(outPath, "utf8")).split(dir).join("<dir>"),
      errors: [],
      warnings: (result.warnings ?? []).map(text),
      errorOffsets: [],
      seconds,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const DEFAULTS = configureTypeWalk({});
afterEach(() => {
  configureTypeWalk(DEFAULTS);
});

/** Seconds one of these builds may take. Each is about a second; without the
 * memo the same builds take from minutes (16 records) to longer than anyone
 * waits (40). */
const LIMIT = 30;

describe("a mapping maps each type it reaches once", () => {
  // Not in this list, because they are NOT fast yet:
  //  - "generic" (members with their own type parameters): every erased
  //    member is mapped under a context of its own, so two members that
  //    reach the same record share nothing and the cost is still 2^records
  //    (1,310,827 mapping steps at 16 records).
  //  - "mesh" with three links at 40 records and more, and any strongly
  //    connected graph whose paths reach MAP_TYPE_MAX_DEPTH: up to 30
  //    records the walk is linear (402 steps), at 40 it takes 53,846, and at
  //    60 the build does not end within 150 s.
  // "the memo changes no mapping" below still covers both at small sizes.
  const cases: [Shape, number, Blocker][] = [
    ["chain", 2, "root"],
    ["chain", 2, "none"],
    ["chain", 2, "deep"],
    ["chain", 3, "root"],
    ["chain", 3, "none"],
    ["lattice", 2, "root"],
    ["lattice", 2, "none"],
    ["ring", 2, "root"],
    ["methods", 2, "root"],
    ["arrays", 2, "root"],
  ];
  for (const n of [24, 40])
    test.each(cases)(
      `%s of ${n} records, %i links each, blocker %s`,
      async (shape, fan, blocker) => {
        const result = await lower(catalogue(shape, n, fan, blocker));
        expect(result.errors).toEqual([]);
        expect(result.seconds).toBeLessThan(LIMIT);
        // The blocked member is the only thing reported, once.
        const codes = result.warnings.map((w) => w.slice(0, 6));
        expect(codes.filter((code) => code !== "SC6104")).toEqual([]);
        expect(codes.length).toBeLessThanOrEqual(1);
      },
      LIMIT * 4000,
    );
});

describe("the memo changes no mapping", () => {
  // Small enough that the mapping without the memo ends too.
  const cases: [Shape, number, number, Blocker][] = [
    ["chain", 9, 2, "root"],
    ["chain", 9, 2, "none"],
    ["chain", 9, 2, "deep"],
    ["chain", 6, 3, "root"],
    ["lattice", 7, 2, "root"],
    ["lattice", 7, 2, "deep"],
    ["ring", 9, 2, "root"],
    ["ring", 9, 2, "none"],
    ["mesh", 7, 3, "root"],
    ["mesh", 7, 3, "deep"],
    ["mesh", 7, 3, "none"],
    ["methods", 5, 2, "root"],
    ["generic", 7, 2, "root"],
    ["arrays", 8, 2, "root"],
    ["arrays", 8, 2, "deep"],
    // Paths as deep as the mapping goes, below and above that depth.
    ["stacks", 6, 2, "none"],
    ["stacks", 9, 2, "none"],
    ["stacks", 9, 2, "root"],
    ["stacks", 11, 2, "deep"],
    ["stacks", 8, 3, "root"],
    ["stackring", 6, 2, "root"],
    ["stackring", 9, 2, "none"],
    ["stackring", 9, 2, "root"],
    ["stackring", 11, 2, "root"],
    ["stackmesh", 9, 2, "none"],
    ["stackmesh", 9, 2, "root"],
    ["stackmesh", 10, 3, "root"],
    ["stackmesh", 10, 3, "deep"],
  ];
  test.each(cases)(
    "%s of %i records, %i links each, blocker %s: the same module with and without it",
    async (shape, n, fan, blocker) => {
      const source = catalogue(shape, n, fan, blocker);
      configureTypeWalk({ memo: "off" });
      const without = await lower(source);
      configureTypeWalk({ memo: "on" });
      const withMemo = await lower(source);
      // Every entry the memo serves is mapped again and compared: a
      // difference is an internal compiler error.
      configureTypeWalk({ memo: "verify" });
      const verified = await lower(source);
      expect(without.errors).toEqual([]);
      expect(withMemo.errors).toEqual([]);
      expect(verified.errors).toEqual([]);
      expect(withMemo.ir).toBe(without.ir);
      expect(verified.ir).toBe(without.ir);
      expect(withMemo.warnings).toEqual(without.warnings);
    },
    240_000,
  );

  // The comparison above covers the depth limit only if the "stack" shapes
  // reach it: below it the type maps, at it the declaration is reported.
  test("the stack shapes are as deep as the mapping goes", async () => {
    const shallow = await lower(catalogue("stacks", 6, 2, "none"));
    const deep = await lower(catalogue("stacks", 9, 2, "none"));
    expect(shallow.errors).toEqual([]);
    expect(deep.errors).toEqual([]);
    expect(shallow.warnings).toEqual([]);
    expect(deep.warnings.map((w) => w.slice(0, 6))).toEqual(["SC6104"]);
  });
});

describe("a mapping that passes the step limit ends the build with SC2016", () => {
  // 40 records map in about 80 steps; nothing else in the program takes 60.
  const source = catalogue("chain", 40, 2, "none");
  const declaration = source.indexOf("type Catalogue =");

  // Not a dynamic slot under the automatic tier: the lenient mapping of the
  // same type would walk the same graph.
  test.each(["auto", "static-only"] as const)(
    "tier %s: one error, at the type's declaration",
    async (tier) => {
      configureTypeWalk({ steps: 60 });
      const result = await lower(source, tier);
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual([
        "SC2016: type 'Catalogue' cannot be compiled: mapping the types it reaches takes more than 60 steps",
      ]);
      expect(result.errorOffsets).toEqual([declaration]);
    },
  );

  test("the lenient mapping of a type with a blocked member ends the build the same way", async () => {
    // The strict mapping stops at the blocked member of the last record, a
    // few steps past the limit either way; what matters is the one error.
    configureTypeWalk({ steps: 60 });
    const blocked = catalogue("chain", 40, 2, "deep");
    const result = await lower(blocked);
    expect(result.errors).toEqual([
      "SC2016: type 'Catalogue' cannot be compiled: mapping the types it reaches takes more than 60 steps",
    ]);
    expect(result.errorOffsets).toEqual([blocked.indexOf("type Catalogue =")]);
  });

  test("the same program builds under the limit that ships", async () => {
    const result = await lower(source);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  // Members with their own type parameters are mapped under a context of
  // their own, so the memo shares nothing between them: 2^24 steps here.
  test("a graph the memo does not shorten ends within seconds", async () => {
    const result = await lower(catalogue("generic", 24, 2, "root"));
    expect(result.errors.map((e) => e.slice(0, 6))).toEqual(["SC2016"]);
    expect(result.errors[0]).toContain("type 'Catalogue' cannot be compiled");
    expect(result.seconds).toBeLessThan(LIMIT);
  }, 120_000);
});
