/* The generative and metamorphic lanes (tests/harness/generative/) run
 * nightly, not on pull requests, because they compile hundreds of programs.
 * These tests keep their inputs honest on every pull request without
 * compiling anything: generators stay deterministic, the baseline still
 * names the programs it was recorded for, and every rewrite still produces
 * a program that parses.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { generate, generatorDigest, generators } from "./generative/generators.mjs";
import { FAILURES } from "./generative/oracle.mjs";
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
