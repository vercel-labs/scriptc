// readdir's option ladder: getOptions accepts an encoding name, an options
// record, null/undefined or a function (treated as {}) and rejects any
// other primitive; assertEncoding runs next, then validateAbortSignal, then
// the path, and only then options.recursive (validateBoolean in the sync
// form, a truthiness test in the promise form). The sync form throws and
// the promise form rejects. The invalid option values arrive as untyped
// values, the way code that bypasses the type checker holds them.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-rdopt-err-"));
fs.mkdirSync(`${dir}/sub`, { recursive: true });
fs.writeFileSync(`${dir}/a.txt`, "a");
fs.writeFileSync(`${dir}/sub/b.txt`, "b");

function any(value: unknown): any {
  return value;
}

function syncCase(label: string, run: () => unknown): void {
  try {
    const value = run();
    console.log(label, "ok", String(value));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, err.code, err.message.replace(dir, "<dir>"));
  }
}

// A function options value means {} — the names list.
syncCase("fn", () => fs.readdirSync(dir, any(() => undefined)).length);
// null and undefined are the defaults.
syncCase("null", () => fs.readdirSync(dir, null).length);
syncCase("undef", () => fs.readdirSync(dir, undefined).length);
// Other primitives fail getOptions.
syncCase("num", () => fs.readdirSync(dir, any(5)));
syncCase("bool", () => fs.readdirSync(dir, any(true)));
syncCase("bigint", () => fs.readdirSync(dir, any(5n)));
// recursive is a boolean in the sync form.
syncCase("rec-num", () => fs.readdirSync(dir, any({ recursive: 1 })));
syncCase("rec-str", () => fs.readdirSync(dir, any({ recursive: "yes" })));
syncCase("rec-null", () => fs.readdirSync(dir, any({ recursive: null })).length);
// The encoding check runs before the recursive one.
syncCase("enc-first", () => fs.readdirSync(dir, any({ encoding: "nope", recursive: 1 })));
// An invalid signal fails validateAbortSignal.
syncCase("signal", () => fs.readdirSync(dir, any({ signal: 5 })));
// The path is validated after the options.
syncCase("born-late", () => fs.readdirSync(`${dir}/missing`, any({ recursive: 1 })));
syncCase("missing", () => fs.readdirSync(`${dir}/missing`, { recursive: true }));
syncCase("notdir", () => fs.readdirSync(`${dir}/a.txt`, { recursive: true }));

async function promiseCase(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const value = await run();
    console.log(label, "ok", String(value));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, err.code, err.message.replace(dir, "<dir>"));
  }
}

async function main(): Promise<void> {
  await promiseCase("p-fn", async () => (await fsp.readdir(dir, any(() => undefined))).length);
  await promiseCase("p-null", async () => (await fsp.readdir(dir, null)).length);
  await promiseCase("p-num", () => fsp.readdir(dir, any(5)));
  // The promise form copies the options object (a function means {}).
  await promiseCase("p-rec-num", async () => (await fsp.readdir(dir, any({ recursive: 1 }))).length);
  await promiseCase("p-rec-zero", async () => {
    const names = await fsp.readdir(dir, any({ recursive: 0 }));
    return names.sort().join(",");
  });
  await promiseCase("p-enc-first", () => fsp.readdir(dir, any({ encoding: "nope", recursive: 1 })));
  await promiseCase("p-signal", () => fsp.readdir(dir, any({ signal: 5 })));
  await promiseCase("p-missing", () => fsp.readdir(`${dir}/missing`, { recursive: true }));
  await promiseCase("p-notdir", () => fsp.readdir(`${dir}/a.txt`, { recursive: true }));
}

main().then(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
