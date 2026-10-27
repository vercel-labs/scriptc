import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.each(["llvm"] as const)(
  "native callable checks preserve supported arguments and reject before invoking (%s)",
  async (backend) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-callable-checks-"));
    try {
      const entry = join(dir, "main.ts");
      writeFileSync(
        join(dir, "close.js"),
        `
export function closeUnknown(value) { return value.close(); }
export function enumerateUnknown(value) {
  Object.defineProperties(value, { extra: { value: "visible", enumerable: true } });
  const keys = [];
  for (const key in value) keys.push(key);
  return keys.join(",");
}
`,
      );
      writeFileSync(
        entry,
        `
import { open } from "node:fs/promises";
import { closeUnknown, enumerateUnknown } from "./close.js";
function join(prefix: string, ...parts: string[]): string { console.log("invoked"); return prefix + parts.join(":"); }
const boxed: unknown = join;
function argument(value: unknown): unknown { console.log("argument"); return value; }
if (typeof boxed === "function") {
  try { boxed(argument("prefix:"), argument("valid"), argument(4)); }
  catch (error) { if (error instanceof Error) console.log(error.name); }
  console.log(boxed("after:", "one", "two"));
}
try { console.log(enumerateUnknown(boxed)); }
catch (error) { if (error instanceof Error) console.log(error.message.includes("for-in over this checked-dynamic kind is not supported yet")); }
const widened = open as (path: string, flags?: string | number, mode?: number | string) => ReturnType<typeof open>;
const operations = { open: widened };
function describe(value: unknown): string { console.log("described"); return typeof value; }
const describeKey = describe as (value: string | symbol) => string;
console.log(describeKey("supported"));
console.log(describeKey(Symbol.for("supported")));
const file = process.argv[2]!;
try { await operations.open(file, 0); }
catch (error) { if (error instanceof Error) console.log(error.name); }
try { await operations.open(file, "w", "600"); }
catch (error) { if (error instanceof Error) console.log(error.name); }
const handle = await operations.open(file, "wx", 0o600);
const stored: unknown = handle;
await closeUnknown(stored);
console.log(handle.fd);
`,
      );
      const result = await compile(entry, {
        backend,
        sanitize,
        outDir: dir,
        outPath: join(dir, "program"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const path = join(dir, "created.txt");
      const child = spawnSync(result.binaryPath, [path], { encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      const stderr =
        sanitize && process.platform === "linux"
          ? child.stderr.replace(
              /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm,
              "",
            )
          : child.stderr;
      expect(stderr).toBe("");
      expect(child.stdout).toBe(
        "argument\nargument\nargument\nTypeError\ninvoked\nafter:one:two\ntrue\ndescribed\nstring\ndescribed\nsymbol\nTypeError\nTypeError\n-1\n",
      );
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each(["llvm"] as const)(
  "failed implicit specializations retain a callable throwing body (%s)",
  async (backend) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-failed-specialization-"));
    try {
      const pkg = join(dir, "node_modules", "callbacks");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(dir, "package.json"), '{"type":"module"}');
      writeFileSync(
        join(pkg, "package.json"),
        '{"name":"callbacks","type":"module","main":"index.js","types":"index.d.ts"}',
      );
      writeFileSync(join(pkg, "index.d.ts"), "export {};\n");
      writeFileSync(
        join(pkg, "index.js"),
        `
const inspect = (value) => process.on("__proto__", value);
function stopped(value) {
  process.on("__proto__", value);
  return { done() { return "wrong"; } };
}
try { console.log(stopped(() => {}).done()); }
catch (error) { console.log(String(error).includes("SC2020")); }
const first = { inspect };
const second = { inspect };
console.log(typeof first.inspect, first.inspect === second.inspect);
for (const callback of [first.inspect, second.inspect]) {
  try { callback(() => {}); }
  catch (error) { console.log(String(error).includes("SC2020")); }
}
`,
      );
      const entry = join(dir, "main.js");
      writeFileSync(entry, 'import "callbacks";');
      const { coverage } = analyze(entry, { npmStatic: "auto" });
      expect(coverage.diagnostics).toEqual([]);
      expect(coverage.runtimeFences?.length).toBeGreaterThan(0);
      const result = await compile(entry, {
        backend,
        npmStatic: "auto",
        sanitize,
        outDir: dir,
        outPath: join(dir, "program"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).toBe("");
      expect(child.stdout).toBe("true\nfunction true\ntrue\ntrue\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
