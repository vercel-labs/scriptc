import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** The library calls of a module, in order of appearance, by name. */
function libCalls(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) libCalls(item, found);
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  const node = value as { kind?: unknown; fn?: unknown };
  if (node.kind === "libCall" && typeof node.fn === "string") found.push(node.fn);
  for (const child of Object.values(value)) libCalls(child, found);
  return found;
}

async function compileSource(source: string, name = "main.ts") {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-intl-formatters-"));
  try {
    const entry = join(dir, name);
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) return { ok: false as const, diagnostics: result.diagnostics };
    return { ok: true as const, module: deserializeModule(await readFile(outPath, "utf8")) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The Intl library calls a program lowers to (`icu.` over ICU, `intl.` the
 * engine-free forms). */
async function intlCalls(source: string, name?: string): Promise<string[]> {
  const result = await compileSource(source, name);
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return libCalls(result.module.functions).filter(
    (fn) => fn.startsWith("icu.") || fn.startsWith("intl."),
  );
}

/** The first diagnostic of a refused program; with `about`, the first one
 * whose message mentions it (a refused call's result type can be reported
 * before the call). */
async function refusalOf(source: string, about?: string): Promise<string> {
  const result = await compileSource(source);
  if (result.ok) throw new Error("expected a refusal");
  const found =
    result.diagnostics.find((d) => about === undefined || d.message.includes(about)) ??
    result.diagnostics[0]!;
  return `${found.code}: ${found.message}`;
}

test("the composed en-US number format without options stays the engine-free formatter", async () => {
  // A program that formats only this way links no ICU: the zero-cost gate
  // holds existing programs to it.
  expect(
    await intlCalls(`
      console.log(new Intl.NumberFormat("en-US").format(1234.5), (1234.5).toLocaleString("en-US"));
      export {};
    `),
  ).toEqual(["intl.numFormatEnUs", "intl.numFormatEnUs"]);
});

test("the default-locale forms without arguments keep their own calls", async () => {
  expect(
    await intlCalls(`
      const d = new Date(0);
      console.log((1234.5).toLocaleString(), d.toLocaleString(), d.toLocaleTimeString());
      export {};
    `),
  ).toEqual(["icu.numFormatDefault", "icu.dateLocaleString", "icu.dateLocaleTimeString"]);
});

test("a formatter with options is constructed and formats through the handle", async () => {
  expect(
    await intlCalls(`
      const percent = new Intl.NumberFormat("en-US", { style: "percent" });
      const stamp = Intl.DateTimeFormat("en-US", { timeZone: "UTC" });
      const when = new Date(0);
      console.log(percent.format(0.5), stamp.format(when), stamp.format(0), stamp.format());
      console.log(new Intl.NumberFormat().format(1), new Intl.NumberFormat(undefined, {}).format(2));
      export {};
    `),
  ).toEqual([
    "icu.numberFormatNew",
    "icu.dateTimeFormatNew",
    "icu.numberFormatFormat",
    "icu.dateTimeFormatFormat",
    "icu.dateTimeFormatFormat",
    "icu.dateTimeFormatFormat",
    "icu.numberFormatFormat",
    "icu.numberFormatNew",
    "icu.numberFormatFormat",
    "icu.numberFormatNew",
  ]);
});

test("toLocale*String with a locale or options constructs the formatter for one call", async () => {
  expect(
    await intlCalls(`
      const d = new Date(0);
      console.log(
        (1234.5).toLocaleString("en-US", { minimumIntegerDigits: 6 }),
        (1234.5).toLocaleString(undefined, { style: "percent" }),
        d.toLocaleDateString(),
        d.toLocaleDateString("en-US", { month: "short" }),
        d.toLocaleTimeString("en", { hourCycle: "h24", second: "2-digit" }),
        d.toLocaleString("en-US"),
      );
      export {};
    `),
  ).toEqual([
    "icu.numToLocaleString",
    "icu.numToLocaleString",
    "icu.dateToLocale",
    "icu.dateToLocale",
    "icu.dateToLocale",
    "icu.dateToLocale",
  ]);
});

test("a checked-dynamic format argument is read by the runtime", async () => {
  expect(
    await intlCalls(`
      const value: unknown = JSON.parse("12");
      const nf = new Intl.NumberFormat("en-US");
      const dtf = new Intl.DateTimeFormat("en-US");
      console.log(nf.format(value as number), dtf.format(value as number));
      export {};
    `),
  ).toContain("icu.numberFormatNew");
  expect(
    await intlCalls(
      `const nf = new Intl.NumberFormat("en-US", { style: "percent" });
       function show(formatter, value) { return formatter.format(value); }
       console.log(nf.format(JSON.parse("0.5")), show(nf, 1));`,
      "main.mjs",
    ),
  ).toContain("icu.numberFormatFormatDyn");
});

test("locales other than the default, en-US and en are refused by name", async () => {
  expect(await refusalOf(`console.log(new Intl.NumberFormat("de-DE").format(1)); export {};`)).toBe(
    `SC2020: 'Intl.NumberFormat at locale "de-DE"' is part of the standard library types but has no scriptc lowering yet`,
  );
  expect(
    await refusalOf(`
      declare const locale: string;
      console.log(new Date(0).toLocaleDateString(locale));
      export {};
    `),
  ).toBe(
    `SC2020: 'Date.prototype.toLocaleDateString with a non-literal locale' is part of the standard library types but has no scriptc lowering yet`,
  );
  expect(
    await refusalOf(`console.log((1).toLocaleString(["en-US", "de-DE"], {})); export {};`),
  ).toMatch(/^SC2020: 'Number\.prototype\.toLocaleString with a non-literal locale'/);
});

test("the members and inputs the formatters do not have are refused by name", async () => {
  expect(
    await refusalOf(`new Intl.NumberFormat("en-US").formatToParts(1); export {};`, "formatToParts"),
  ).toMatch(/^SC2020: 'Intl\.NumberFormat\.prototype\.formatToParts'/);
  expect(
    await refusalOf(`console.log(new Intl.DateTimeFormat("en-US").formatRange(0, 1)); export {};`),
  ).toMatch(/^SC2020: 'Intl\.DateTimeFormat\.prototype\.formatRange'/);
  expect(
    await refusalOf(`console.log(new Intl.NumberFormat("en-US", {}).format(12n)); export {};`),
  ).toMatch(/^SC2020: 'Intl\.NumberFormat\.prototype\.format over a '12n''/);
  expect(
    await refusalOf(
      `console.log(new Intl.DateTimeFormat("en-US", { calendar: "buddhist" }).format(0)); export {};`,
    ),
  ).toMatch(/^SC2020: 'the Intl\.DateTimeFormat option 'calendar''/);
  expect(
    await refusalOf(`console.log(new Intl.PluralRules("en-US").select(1)); export {};`),
  ).toMatch(/^SC2020: 'new Intl\.PluralRules'/);
});
