import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test.each([
  [
    "typed listeners",
    `/** @param {number} value */ function listener(value) { console.log(value); }
    const ee = new EventEmitter(); ee.on('value', listener); ee.emit('value'); ee.emit('value', 1);`,
    "conflicting argument types",
  ],
  [
    "emit overrides",
    `class Derived extends EventEmitter { emit(event, ...args) { return super.emit(event, ...args); } }
    const ee = new Derived(); ee.on('value', (value) => console.log(value)); ee.emit('value'); ee.emit('value', 1);`,
    "variable-arity emit through an EventEmitter subclass overriding emit",
  ],
  [
    "reserved stream events",
    `const ee = new EventEmitter(); ee.on('data', (value) => console.log(value));
    ee.emit('data'); ee.emit('data', 1);`,
    "conflicting argument types",
  ],
])("keeps named refusals for %s", (_name, source, message) => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-flex-events-"));
  try {
    const entry = join(dir, "main.cjs");
    writeFileSync(entry, `const { EventEmitter } = require('node:events');\n${source}\n`);
    const { coverage } = analyze(entry, {});
    const diagnostics = [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])];
    expect(
      diagnostics.some((d) => d.code === "SC2020" && d.message.includes(message!)),
      JSON.stringify(diagnostics),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
