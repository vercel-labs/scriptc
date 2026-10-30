// @requires-libnode
// Arguments crossing into a Node island keep JavaScript's exact shape:
// explicit `undefined` arguments count (arguments.length, default
// parameters), an omitted optional field is absent while one holding
// `undefined` is present (`in`, hasOwnProperty, Object.keys), and native
// number arrays arrive as arrays.
import {
  probe,
  defaults,
  version,
  inspect,
  nodeVersionFor,
  cwd,
  envValue,
  plain,
  type Config,
} from "argprobe";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Settings {
  nodeVersion?: string;
}
function settingsFor(flag: boolean): Settings | undefined {
  return flag ? { nodeVersion: "20.x" } : undefined;
}

console.log(probe());
console.log(probe(undefined));
console.log(probe("a", undefined));
console.log(probe("a", {}, undefined));
console.log(probe("a", { nodeVersion: undefined }, undefined, [18, 20, 22]));
const settings = settingsFor(false);
console.log(probe("a", { nodeVersion: settings?.nodeVersion }, undefined, [22]));
console.log(probe("a", { label: "x", nodeVersion: undefined }));

console.log(defaults());
console.log(defaults(undefined));
console.log(defaults(undefined, "y"));
console.log(defaults("x", undefined, "r"));

const available: number[] = [18, 20, 22];
console.log(version("/work", "unused", { nodeVersion: settings?.nodeVersion }, undefined, available));
console.log(version("/work", "unused", { nodeVersion: settingsFor(true)?.nodeVersion }, undefined, available));
console.log(version("/work", undefined, undefined, undefined, available));
console.log(inspect({ nodeVersion: undefined, list: [1, undefined, 3] }));

// A native object typed by the island's own interface, read with `?.`.
function projectSettings(flag: boolean): Config | undefined {
  return flag ? { nodeVersion: "20.x", label: "proj" } : undefined;
}
const project = projectSettings(true);
const none = projectSettings(false);
console.log(version("/work", "unused", { nodeVersion: project?.nodeVersion }, undefined, available));
console.log(version("/work", "unused", { nodeVersion: none?.nodeVersion }, undefined, available));
console.log(probe("p", { nodeVersion: project?.nodeVersion }), probe("n", { nodeVersion: none?.nodeVersion }));
const claims = { role: "admin" };
console.log("plain", plain({ sub: "alice" }), plain(claims));

async function main(): Promise<void> {
  // A package.json the program writes just before the island reads it.
  const dir = mkdtempSync(join(tmpdir(), "argprobe-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: "22.x" } }));
    console.log(await nodeVersionFor(dir, "unused", { nodeVersion: settings?.nodeVersion }, undefined, available));
    rmSync(join(dir, "package.json"));
    console.log(await nodeVersionFor(dir, "unused", { nodeVersion: "18.x" }, { isDev: true }));
    try {
      await nodeVersionFor(dir, "unused", { nodeVersion: settings?.nodeVersion }, undefined, available);
    } catch (e) {
      console.log("rejected", (e as Error).message);
    }
    // Process state the program changes after Node loaded is Node's too.
    const before = process.cwd();
    process.chdir(dir);
    console.log("cwd", cwd() === process.cwd(), cwd() === before);
    process.chdir(before);
    process.env["ARGPROBE_SETTING"] = "set-natively";
    console.log("env", envValue("ARGPROBE_SETTING"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
void main();
