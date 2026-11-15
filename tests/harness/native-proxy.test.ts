import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

for (const backend of ["llvm"] as const) {
  test(`native Proxy boundaries unwind catchably (${backend})`, async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scriptc-proxy-boundaries-"));
    const entry = join(outDir, "main.mjs");
    writeFileSync(
      entry,
      `
const proxy = new Proxy({}, {});
function stringify(value) { return String(value); }
function add(left, right) { return left + right; }
function wrap(value) { return [value]; }
try { stringify(proxy); } catch (error) { console.log(error.message); }
try { stringify(wrap(proxy)); } catch (error) { console.log(error.message); }
try { add(wrap(proxy), 1); } catch (error) { console.log(error.message); }
try { proxy.value = 1; } catch (error) { console.log(error.message); }
try { Object.assign({}, proxy); } catch (error) { console.log(error.message); }
try { JSON.stringify(proxy); } catch (error) { console.log(error.message); }
try { structuredClone(proxy); } catch (error) { console.log(error.name); }
const falsish = new Proxy({}, { set() { return false; }, deleteProperty() { return false; } });
try { falsish.value = 1; } catch (error) { console.log(error.message); }
try { delete falsish.value; } catch (error) { console.log(error.message); }
console.log("after");
`,
    );
    const result = await compile(entry, {
      backend,
      sanitize: process.env["SCRIPTC_SAN"] === "1",
      outDir,
      outPath: join(outDir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    expect(stdout).toBe(
      [
        // String() and string concatenation run the Proxy's ToPrimitive
        // through its traps: an empty handler inherits Object.prototype's
        // toString, so both the Proxy and an array holding it answer the
        // object tag, as Node's do. The three conversions below therefore
        // print nothing.
        "assignment without a set trap on a native Proxy is not supported yet",
        "Object.assign on a native Proxy is not supported yet",
        "JSON.stringify on a native Proxy is not supported yet",
        "DataCloneError",
        "falsish set traps on a native Proxy is not supported yet",
        "falsish deleteProperty traps on a native Proxy is not supported yet",
        "after",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("");
  });
  test(`a native Proxy in a typed slot reports its own diagnostic (${backend})`, async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scriptc-proxy-typed-slot-"));
    const entry = join(outDir, "main.ts");
    writeFileSync(
      entry,
      `
class Holder {
  n = 5;
}
const target: any = { n: 1 };
const proxy = new Proxy(target, {
  get(t: any, k: any): any {
    return t[k];
  },
});
try {
  const holder: Holder = proxy;
  console.log(holder.n);
} catch (error: any) {
  console.log(error.name);
  console.log(error.message);
  console.log(error.code);
}
`,
    );
    const result = await compile(entry, {
      backend,
      sanitize: process.env["SCRIPTC_SAN"] === "1",
      outDir,
      outPath: join(outDir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    expect(stdout).toBe(
      [
        "TypeError",
        "expected Holder at $, got a native Proxy (a native Proxy keeps its traps only in an untyped value, an interface or object type, or a dictionary, and a class type holds only instances of the class: declare the value 'any', an interface, or a Record<string, T>)",
        "SC2020",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("");
  });
}
