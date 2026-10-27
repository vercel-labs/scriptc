/* Timer handles under @types/node 20 and older, which declare
 * NodeJS.Timeout and NodeJS.Immediate as classes (22+ declare interfaces,
 * like scriptc's own declarations). The handles must map to the native
 * timer handle either way: stored in nullable fields, cleared, and their
 * ref/unref/hasRef/refresh methods called. The fixture's @types/node is the
 * 20.x timer surface, trimmed to what the program uses. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const dir = mkdtempSync(join(tmpdir(), "scriptc-node20-timers-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const typesNode = `// @types/node 20.x: Timeout and Immediate are classes.
declare namespace NodeJS {
  interface Timer {
    hasRef(): boolean;
    ref(): this;
    refresh(): this;
    unref(): this;
  }
  class Immediate {
    hasRef(): boolean;
    ref(): this;
    unref(): this;
  }
  class Timeout implements Timer {
    hasRef(): boolean;
    ref(): this;
    refresh(): this;
    unref(): this;
  }
}
declare function setTimeout(callback: () => void, ms?: number): NodeJS.Timeout;
declare function clearTimeout(timeoutId: NodeJS.Timeout | string | number | undefined): void;
declare function setImmediate(callback: () => void): NodeJS.Immediate;
declare function clearImmediate(immediateId: NodeJS.Immediate | undefined): void;
interface Console {
  log(...data: unknown[]): void;
}
declare var console: Console;
`;

const program = `class Holder {
  timer: NodeJS.Timeout | null = null;
}
const holder = new Holder();
holder.timer = setTimeout(() => console.log("never"), 1000);
// Long enough that the immediate runs first even on a loaded machine.
const kept = setTimeout(() => console.log("fired", holder.timer === null), 200);
kept.unref().ref();
kept.refresh();
console.log("hasRef", kept.hasRef());
if (holder.timer !== null) clearTimeout(holder.timer);
holder.timer = null;
const imm = setImmediate(() => console.log("immediate"));
imm.unref().ref();
`;

test("@types/node 20 class-declared timer handles compile and match Node", async () => {
  const types = join(dir, "node_modules/@types/node");
  mkdirSync(types, { recursive: true });
  writeFileSync(
    join(types, "package.json"),
    '{ "name": "@types/node", "version": "20.16.5", "types": "index.d.ts" }\n',
  );
  writeFileSync(join(types, "index.d.ts"), typesNode);
  writeFileSync(
    join(dir, "tsconfig.json"),
    '{ "compilerOptions": { "strict": true, "types": ["node"] } }\n',
  );
  writeFileSync(join(dir, "main.ts"), program);
  const out = join(dir, ".scriptc");
  const result = await compile(join(dir, "main.ts"), {
    outPath: join(out, "program"),
    outDir: out,
    sanitize,
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  // One after the other, and the timer 200 ms out: under load Node's own
  // startup can outlast a short timer, which then runs before the
  // immediate.
  const node = await execFileAsync(process.execPath, [join(dir, "main.ts")], {
    cwd: dir,
    encoding: "utf8",
  });
  const native = await execFileAsync(result.binaryPath, [], { cwd: dir, encoding: "utf8" });
  expect(native.stdout).toBe(node.stdout);
  expect(native.stdout).toBe("hasRef true\nimmediate\nfired true\n");
}, 180_000);
