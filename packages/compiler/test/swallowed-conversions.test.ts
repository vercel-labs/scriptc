/* SC6009 and the scan behind it (frontend/lowering/swallowed-conversions.ts):
 * a checked conversion of unverified data whose failure ends in a handler
 * that neither reads the error nor throws. These tests pin which handler
 * shapes swallow and which do not, by the line of the conversion; that a
 * build's warnings are the claims a coverage report marks; and what a
 * failure is followed through. tests/harness/swallowed-conversions.test.ts
 * runs the same shapes under Node and natively. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

/** The SC6009 warnings of `source`, one string per warning in source order:
 * `<line of the conversion> <handler kind>@<line of the handler>`, with
 * ` via <line of the call>` when the failure travels through a call. */
function swallowed(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-swallowed-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const { coverage } = analyze(entry);
    expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    const line = (offset: number): number => source.slice(0, offset).split("\n").length;
    const marked = (coverage.typeClaims ?? [])
      .filter((site) => site.swallowed !== undefined)
      .map((site) => {
        const s = site.swallowed!;
        const via = s.through === undefined ? "" : ` via ${line(s.through.start)}`;
        return `${line(site.loc.start)} ${s.handler.kind}@${line(s.handler.loc.start)}${via}`;
      })
      .sort((a, b) => Number.parseInt(a) - Number.parseInt(b));
    // The warnings are exactly the claims the report marks.
    const warned = (coverage.divergences ?? [])
      .filter((d) => d.code === "SC6009")
      .map((d) => line(d.loc.start))
      .sort((a, b) => a - b);
    expect(warned).toEqual(marked.map((m) => Number.parseInt(m)));
    return marked;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ENTRY = `interface Entry { id: number; name: string }
const seen: unknown[] = [];
function log(e: unknown): void { seen.push(e); }
`;
/** `body` as the function `f(text)`, called once; its first line is line 4. */
const fn = (body: string, extra = ""): string =>
  `${ENTRY}${body}\n${extra}console.log(f("{}"), seen.length);\n`;

test("a catch without a binding, and one whose binding nothing reads, swallow", () => {
  expect(
    swallowed(
      fn(`function f(text: string): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } catch {
    return null;
  }
}`),
    ),
  ).toEqual(["6 catch@5"]);
  expect(
    swallowed(
      fn(`function f(text: string): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } catch (e) {
    return null;
  }
}`),
    ),
  ).toEqual(["6 catch@5"]);
});

test("a handler that reads the error has seen it", () => {
  for (const handler of [
    "log(e); return null;",
    "throw e;",
    "if (e instanceof SyntaxError) return null; throw e;",
    "console.error(String(e)); return null;",
    // A function the handler creates reads it.
    "const later = (): void => log(e); later(); return null;",
  ]) {
    expect(
      swallowed(
        fn(`function f(text: string): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } catch (e) {
    ${handler}
  }
}`),
      ),
      handler,
    ).toEqual([]);
  }
});

test("a handler that always throws replaces the error, which goes on outwards", () => {
  // Nothing outside: the replacement leaves the function.
  expect(
    swallowed(
      `${ENTRY}function f(text: string): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } catch {
    throw new Error("bad entry");
  }
}
try { console.log(f("{}")); } catch (e) { log(e); }
`,
    ),
  ).toEqual([]);
  // A handler outside that ignores the replacement swallows both.
  expect(
    swallowed(
      fn(`function f(text: string): Entry | null {
  try {
    try {
      return JSON.parse(text) as Entry;
    } catch {
      throw new Error("bad entry");
    }
  } catch {
    return null;
  }
}`),
    ),
  ).toEqual(["7 catch@5"]);
  // A throw on one path only: the other path completes.
  expect(
    swallowed(
      `${ENTRY}function f(text: string, strict: boolean): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } catch {
    if (strict) throw new Error("bad entry");
    return null;
  }
}
console.log(f("{}", false));
`,
    ),
  ).toEqual(["6 catch@5"]);
});

test("the innermost handler decides: seen inside is not swallowed outside", () => {
  expect(
    swallowed(
      fn(`function f(text: string): Entry | null {
  try {
    try {
      return JSON.parse(text) as Entry;
    } catch (e) {
      log(e);
      throw e;
    }
  } catch {
    return null;
  }
}`),
    ),
  ).toEqual([]);
});

test("try/finally: a finally that runs on passes the error, one that leaves discards it", () => {
  expect(
    swallowed(
      `${ENTRY}function f(text: string): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } finally {
    seen.length = 0;
  }
}
try { console.log(f("{}")); } catch (e) { log(e); }
`,
    ),
  ).toEqual([]);
  expect(
    swallowed(
      fn(`function f(text: string): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } finally {
    return null;
  }
}`),
    ),
  ).toEqual(["6 finally@5"]);
  // A try/finally inside a try whose handler ignores the error.
  expect(
    swallowed(
      fn(`function f(text: string): Entry | null {
  try {
    try {
      return JSON.parse(text) as Entry;
    } finally {
      seen.length = 0;
    }
  } catch {
    return null;
  }
}`),
    ),
  ).toEqual(["7 catch@5"]);
  // A break inside a loop of the finally stays inside it.
  expect(
    swallowed(
      `${ENTRY}function f(text: string): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } finally {
    for (const s of seen) { if (s === null) break; }
  }
}
try { console.log(f("{}")); } catch (e) { log(e); }
`,
    ),
  ).toEqual([]);
});

test("a conversion in the handler is not guarded by that handler", () => {
  expect(
    swallowed(
      `${ENTRY}function f(text: string, fallback: string): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } catch (e) {
    log(e);
    return JSON.parse(fallback) as Entry;
  }
}
try { console.log(f("{}", "{}")); } catch (e) { log(e); }
`,
    ),
  ).toEqual([]);
});

test("a loop that goes on to the next item swallows", () => {
  expect(
    swallowed(
      `${ENTRY}function f(texts: string[]): Entry[] {
  const out: Entry[] = [];
  for (const text of texts) {
    try {
      out.push(JSON.parse(text) as Entry);
    } catch {
      continue;
    }
  }
  return out;
}
console.log(f(["{}"]).length);
`,
    ),
  ).toEqual(["8 catch@7"]);
});

test("a directly called function hands its failures to the caller's handler, one level", () => {
  expect(
    swallowed(
      fn(`function decode(text: string): Entry {
  return JSON.parse(text) as Entry;
}
function f(text: string): Entry | null {
  try {
    return decode(text);
  } catch {
    return null;
  }
}`),
    ),
  ).toEqual(["5 catch@8 via 9"]);
  // Two calls away is not reported.
  expect(
    swallowed(
      fn(`function decode(text: string): Entry {
  return JSON.parse(text) as Entry;
}
function relay(text: string): Entry {
  return decode(text);
}
function f(text: string): Entry | null {
  try {
    return relay(text);
  } catch {
    return null;
  }
}`),
    ),
  ).toEqual([]);
  // A conversion the callee's own handler sees does not leave it.
  expect(
    swallowed(
      fn(`function decode(text: string): Entry | undefined {
  try {
    return JSON.parse(text) as Entry;
  } catch (e) {
    log(e);
    return undefined;
  }
}
function f(text: string): Entry | null {
  try {
    return decode(text) ?? null;
  } catch {
    return null;
  }
}`),
    ),
  ).toEqual([]);
});

const ASYNC = `${ENTRY}async function load(text: string): Promise<Entry> {
  return JSON.parse(text) as Entry;
}
async function text(s: string): Promise<string> {
  return s;
}
`;
/** `body` as the async function `f(s)`, awaited once; its first line is line 10. */
const asyncFn = (body: string): string =>
  `${ASYNC}${body}\nconsole.log(await f("{}"), seen.length);\n`;

test("an async function's failure reaches a handler where the call is awaited", () => {
  expect(
    swallowed(
      asyncFn(`async function f(s: string): Promise<Entry | null> {
  try {
    return await load(s);
  } catch {
    return null;
  }
}`),
    ),
  ).toEqual(["5 catch@11 via 12"]);
  // Returned without await, the promise settles after the handler is left.
  expect(
    swallowed(
      `${ASYNC}async function f(s: string): Promise<Entry | null> {
  try {
    return load(s);
  } catch {
    return null;
  }
}
f("{}").then((v) => console.log(v), (e: unknown) => log(e));
`,
    ),
  ).toEqual([]);
});

test("a rejection handler that ignores the reason swallows what rejects the promise", () => {
  // A direct call of an async function.
  expect(
    swallowed(
      asyncFn(`async function f(s: string): Promise<Entry | null> {
  return load(s).catch(() => null);
}`),
    ),
  ).toEqual(["5 rejection@11 via 11"]);
  // A callback written in the chain.
  expect(
    swallowed(
      asyncFn(`async function f(s: string): Promise<Entry | null> {
  return text(s)
    .then((t) => JSON.parse(t) as Entry)
    .catch(() => null);
}`),
    ),
  ).toEqual(["12 rejection@11"]);
  // An async function literal called where it is written.
  expect(
    swallowed(
      asyncFn(`async function f(s: string): Promise<Entry | null> {
  return (async () => JSON.parse(s) as Entry)().catch(() => null);
}`),
    ),
  ).toEqual(["11 rejection@11"]);
  // The chain awaited inside a try.
  expect(
    swallowed(
      asyncFn(`async function f(s: string): Promise<Entry | null> {
  try {
    return await text(s).then((t) => JSON.parse(t) as Entry);
  } catch {
    return null;
  }
}`),
    ),
  ).toEqual(["12 catch@11"]);
});

test("a rejection handler that reads the reason, or is not a function literal, has seen it", () => {
  expect(
    swallowed(
      asyncFn(`async function f(s: string): Promise<Entry | null> {
  return load(s).catch((e: unknown) => {
    log(e);
    return null;
  });
}`),
    ),
  ).toEqual([]);
  expect(
    swallowed(
      asyncFn(`const ignore = (): null => null;
async function f(s: string): Promise<Entry | null> {
  return load(s).catch(ignore);
}`),
    ),
  ).toEqual([]);
});

test("a program's own helper that guards a callback is read like a promise chain", () => {
  expect(
    swallowed(
      fn(`function attempt<T>(make: () => T): T | null {
  try {
    return make();
  } catch {
    return null;
  }
}
function f(text: string): Entry | null {
  return attempt(() => JSON.parse(text) as Entry);
}`),
    ),
  ).toEqual(["12 catch@5"]);
  // The helper reads the error: nothing is swallowed.
  expect(
    swallowed(
      fn(`function attempt<T>(make: () => T): T | null {
  try {
    return make();
  } catch (e) {
    log(e);
    return null;
  }
}
function f(text: string): Entry | null {
  return attempt(() => JSON.parse(text) as Entry);
}`),
    ),
  ).toEqual([]);
});

test("only a conversion of unverified data is a warning", () => {
  // A typed value read back out of an untyped view in one expression is
  // the compiler's own conversion: it cannot fail.
  expect(
    swallowed(
      `${ENTRY}function f(entry: Entry): number {
  try {
    const view: unknown = entry;
    return typeof view === "object" ? entry.id : 0;
  } catch {
    return -1;
  }
}
console.log(f({ id: 1, name: "a" }));
`,
    ),
  ).toEqual([]);
  // A value read from an \`any\` binding into a typed slot is a claim.
  expect(
    swallowed(
      `${ENTRY}function f(body: any): number {
  try {
    const id: number = body.id;
    return id;
  } catch {
    return -1;
  }
}
console.log(f(JSON.parse("{}")));
`,
    ),
  ).toEqual(["6 catch@5"]);
});
