import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { nodeFrontendServices } from "./services-node.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function rewrite(source: string): string | null {
  return nodeFrontendServices().tscBuiltinImports(source, "/pkg/index.js");
}

const helpers = `"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
`;

function expectSameBehavior(source: string): string {
  const result = rewrite(source);
  expect(typeof result).toBe("string");
  const dir = mkdtempSync(join(tmpdir(), "scriptc-tsc-builtin-imports-"));
  dirs.push(dir);
  writeFileSync(join(dir, "original.cjs"), source);
  writeFileSync(join(dir, "rewritten.cjs"), result!);
  const run = (file: string) =>
    spawnSync(process.execPath, [join(dir, file)], { encoding: "utf8" });
  const oracle = run("original.cjs");
  expect(oracle.status).toBe(0);
  expect(run("rewritten.cjs").stdout).toBe(oracle.stdout);
  return result!;
}

test("builtin modules behind tsc's interop helpers become plain requires", () => {
  const out = expectSameBehavior(`${helpers}const events_1 = __importDefault(require("events"));
const path = __importStar(require("node:path"));
class Bus extends events_1.default.EventEmitter {}
console.log(new Bus() instanceof events_1.default, path.basename("/a/b.txt"), typeof path.join);
`);
  expect(out).toContain('const events_1 = require("events");');
  expect(out).toContain("class Bus extends events_1.EventEmitter {}");
  expect(out).toContain('const path = require("node:path");');
});

test("other references, program modules and default reads of a namespace keep their text", () => {
  // The binding itself as a value.
  expect(
    rewrite(
      `${helpers}const events_1 = __importDefault(require("events"));\nconsole.log(events_1);\n`,
    ),
  ).toBeNull();
  // A program module (cjs-tsc-interop.ts owns it).
  expect(
    rewrite(`${helpers}const m = __importDefault(require("./m"));\nm.default();\n`),
  ).toBeNull();
  // `ns.default` reads the namespace copy's own default.
  expect(
    rewrite(`${helpers}const p = __importStar(require("path"));\nconsole.log(p.default === p);\n`),
  ).toBeNull();
});
