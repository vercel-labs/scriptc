/* The generative and metamorphic lanes (tests/harness/generative/) run
 * nightly, not on pull requests, because they compile hundreds of programs.
 * These tests keep their inputs honest on every pull request without
 * compiling anything: generators stay deterministic, the baseline still
 * names the programs it was recorded for, and every rewrite still produces
 * a program that parses.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { generate, generatorDigest, generators } from "./generative/generators.mjs";
import { companionFiles, FAILURES, recordGeneratorDigests } from "./generative/oracle.mjs";
import { rewrites, syntaxErrors } from "./generative/rewrites.mjs";

const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const baseline = JSON.parse(
  readFileSync(join(import.meta.dirname, "generative/baseline.json"), "utf8"),
) as {
  digests: Record<string, string>;
  programs: string[];
  generate: Record<string, string>;
  metamorphic: Record<string, string>;
};

describe("generators", () => {
  for (const name of Object.keys(generators)) {
    test(`${name} is a function of its seed and index`, () => {
      const emit = (seed: number, index: number): string =>
        JSON.stringify(generate(name, seed, index));
      expect(emit(3, 17)).toBe(emit(3, 17));
      expect(emit(3, 17)).not.toBe(emit(3, 18));
      expect(emit(3, 17)).not.toBe(emit(4, 17));
    });

    test(`${name} emits programs that parse`, () => {
      for (let index = 0; index < 25; index++) {
        expect(syntaxErrors(generate(name, 1, index)["main.ts"])).toEqual([]);
      }
    });

    // A baseline key names a program by seed and index, so a generator that
    // emits something else needs its baseline recorded again.
    test(`the baseline was recorded for what ${name} emits now`, () => {
      expect(baseline.digests[name]).toBe(generatorDigest(name));
    });
  }
});

describe("baseline", () => {
  test("generated failures name a generator, a seed and an index", () => {
    for (const [key, category] of Object.entries(baseline.generate)) {
      const [generator, seed, index] = key.split("/");
      expect(Object.keys(generators), key).toContain(generator);
      expect(seed, key).toMatch(/^\d+$/);
      expect(index, key).toMatch(/^\d{4}$/);
      expect([...FAILURES, "type-error"], key).toContain(category);
    }
  });

  test("the programs the metamorphic lane rewrites are corpus programs", () => {
    expect(baseline.programs.length).toBeGreaterThan(0);
    for (const name of baseline.programs) {
      expect(existsSync(join(corpusDir, name)), name).toBe(true);
    }
  });

  test("metamorphic failures name a listed program and a rewrite", () => {
    for (const [key, category] of Object.entries(baseline.metamorphic)) {
      const cut = key.lastIndexOf("/");
      expect(baseline.programs, key).toContain(key.slice(0, cut));
      expect(Object.keys(rewrites), key).toContain(key.slice(cut + 1));
      expect([...FAILURES, "warned-diff"], key).toContain(category);
    }
  });
});

describe("recording", () => {
  const recorded = () => ({
    digests: { records: "old-records", numbers: "same-numbers", islands: "old-islands" },
    programs: [],
    generate: {
      "records/1/0003": "silent-diff",
      "records/1/0150": "silent-diff",
      "records/2/0001": "refused",
      "numbers/1/0007": "runtime-error",
      "islands/1/0024": "silent-diff",
    },
    metamorphic: {},
  });
  const digestOf = (name: string): string =>
    ({ records: "new-records", numbers: "same-numbers", islands: "new-islands" })[name]!;

  test("a digest moves only with a run of its generator", () => {
    const baseline = recorded();
    // A run of `records` and `numbers`: `islands` was left out (no libnode
    // pack), so its digest and its keys stay as they were recorded, and the
    // digest check still stops a later comparison across the change.
    recordGeneratorDigests(baseline, ["records", "numbers"], {}, digestOf);
    expect(baseline.digests).toEqual({
      records: "new-records",
      numbers: "same-numbers",
      islands: "old-islands",
    });
    expect(baseline.generate["islands/1/0024"]).toBe("silent-diff");
    expect(baseline.generate["numbers/1/0007"]).toBe("runtime-error");
    // No generator ran (the metamorphic lane): nothing moves.
    const untouched = recorded();
    recordGeneratorDigests(untouched, [], {}, digestOf);
    expect(untouched).toEqual(recorded());
  });

  test("a generator that changed keeps only the keys the run observed", () => {
    const baseline = recorded();
    // The run covered seed 1, programs 0..49, and saw one failure there.
    // The keys recorded for the old generator name other programs now, the
    // ones outside the run's range too.
    const observed = { "records/1/0003": "refused" };
    Object.assign(baseline.generate, observed);
    recordGeneratorDigests(baseline, ["records"], observed, digestOf);
    expect(Object.keys(baseline.generate).sort()).toEqual([
      "islands/1/0024",
      "numbers/1/0007",
      "records/1/0003",
    ]);
    expect(baseline.digests.records).toBe("new-records");
  });
});

describe("reducing", () => {
  test("a program is moved with the files it reads beside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-companions-"));
    try {
      mkdirSync(join(dir, "sub"));
      // An island program names its module in a call, a split program
      // imports its second module under the name its output will have.
      writeFileSync(
        join(dir, "main.ts"),
        [
          'import { callSync } from "@scriptc/node";',
          'import { helper } from "./helper.js";',
          'console.log(helper(), callSync<number>("./island.cjs", "count"), "./absent.js");',
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "helper.ts"),
        'import { deep } from "./sub/deep.js";\nexport const helper = (): number => deep;\n',
      );
      writeFileSync(join(dir, "sub/deep.ts"), 'import "../main.js";\nexport const deep = 1;\n');
      writeFileSync(join(dir, "island.cjs"), "exports.count = () => 1;\n");
      writeFileSync(join(dir, "unrelated.ts"), "export {};\n");
      expect(companionFiles(join(dir, "main.ts"))).toEqual([
        "helper.ts",
        "island.cjs",
        join("sub", "deep.ts"),
      ]);
      // A file outside the program's directory cannot keep its place.
      expect(() => companionFiles(join(dir, "sub/deep.ts"))).toThrow(
        "outside the program's directory",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the programs the generators emit name their own companions", () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-companions-"));
    try {
      const files = generate("islands", 1, 3);
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      expect(companionFiles(join(dir, "main.ts"))).toEqual(
        Object.keys(files)
          .filter((name) => name !== "main.ts")
          .sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rewrites", () => {
  const program = [
    `import { join } from "node:path";`,
    `interface Point { x: number; y?: number }`,
    `function double(n: number): number { return n * 2; }`,
    `const origin: Point = { x: 0 };`,
    `const label = join("a", String(double(origin.x)));`,
    `const twice = (n: number): number => n * 2;`,
    `console.log(label, twice(1));`,
    ``,
  ].join("\n");
  const main = (name: string): string => {
    const variant = rewrites[name](program, "program.ts");
    expect(variant, name).not.toBeNull();
    return variant.files["main.ts"];
  };

  test("a value takes a detour through a generic function", () => {
    const text = main("id");
    expect(text).toContain(`function __same<T>(v: T): T { return v; }`);
    expect(text).toContain(`const origin: Point = __same({ x: 0 });`);
    expect(text).toContain(`const label = __same(join("a", String(double(origin.x))));`);
    // The helper follows the imports, and a function keeps the name its
    // binding gives it.
    expect(text.indexOf("function __same")).toBeGreaterThan(text.indexOf(`from "node:path"`));
    expect(text).toContain(`const twice = (n: number): number => n * 2;`);
  });

  test("the other detours wrap the same sites", () => {
    expect(main("unknown")).toContain(`const u: unknown = v; return u as T;`);
    expect(main("field")).toContain(`const box = { v }; return box.v;`);
    expect(main("array")).toContain(`const items: T[] = [v]; return items[0] as T;`);
    expect(main("arrow")).toContain(`const origin: Point = (() => ({ x: 0 }))();`);
  });

  test("an annotated value is cast to its own type or widened", () => {
    expect(main("cast")).toContain(`const origin: Point = (({ x: 0 }) as unknown as Point);`);
    expect(main("cast")).toContain(`const label = join(`);
    expect(main("readonly")).toContain(`const origin: Readonly<Point> = { x: 0 };`);
  });

  test("the program moves into a function below its imports", () => {
    const text = main("function");
    expect(text.indexOf("function __program(): void {")).toBeGreaterThan(
      text.indexOf(`from "node:path"`),
    );
    expect(text.trimEnd().endsWith("__program();")).toBe(true);
  });

  test("a function that uses no other binding moves to a second module", () => {
    const variant = rewrites["module"](program, "program.ts");
    expect(variant.files["moved.ts"]).toBe(
      `export function double(n: number): number { return n * 2; }\n`,
    );
    expect(variant.files["main.ts"]).toContain(`import { double } from "./moved.ts";`);
    expect(variant.files["main.ts"]).not.toContain(`function double`);
  });

  test("a rewrite that cannot apply answers null", () => {
    expect(rewrites["function"](`export const a = 1;\n`, "program.ts")).toBeNull();
    expect(rewrites["function"](`const a = await Promise.resolve(1);\n`, "program.ts")).toBeNull();
    expect(rewrites["arrow"](`const a = await Promise.resolve(1);\n`, "program.ts")).toBeNull();
    expect(rewrites["cast"](`const a = 1;\n`, "program.ts")).toBeNull();
    expect(
      rewrites["module"](`const k = 1;\nfunction f(): number { return k; }\n`, "p.ts"),
    ).toBeNull();
  });

  // Every 40th corpus program through every rewrite: whatever the corpus
  // contains, a rewrite answers null or files that parse.
  test("rewritten corpus programs parse", () => {
    const programs = readdirSync(corpusDir)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .filter((_, index) => index % 40 === 7);
    expect(programs.length).toBeGreaterThan(50);
    for (const name of programs) {
      const source = readFileSync(join(corpusDir, name), "utf8");
      if (syntaxErrors(source, name).length > 0) continue;
      for (const [rewrite, apply] of Object.entries(rewrites)) {
        const variant = apply(source, name);
        if (variant === null) continue;
        for (const [file, text] of Object.entries(variant.files as Record<string, string>)) {
          expect(syntaxErrors(text, file), `${name} ${rewrite} ${file}`).toEqual([]);
        }
      }
    }
  });
});
