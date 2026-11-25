import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflight, loadProgram } from "../src/frontend/program-node.js";

test("bundled Node declarations describe process listener payloads and shared stat options", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fallback-callbacks-"));
  try {
    writeFileSync(join(directory, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    const entry = join(directory, "main.ts");
    const bindings = ["process", "bare", "prefixed"];
    const methods = ["on", "once", "off", "removeListener"];
    const calls = bindings.flatMap((binding) => [
      ...methods.flatMap((method) => [
        `${binding}.${method}("unhandledRejection", (reason, promise) => {
           exact<Equal<typeof reason, unknown>>();
           exact<Equal<typeof promise, Promise<unknown>>>();
         });`,
        `${binding}.${method}("rejectionHandled", promise => {
           exact<Equal<typeof promise, Promise<unknown>>>();
         });`,
        `${binding}.${method}("multipleResolves", (_type, promise, value) => {
           exact<Equal<typeof promise, Promise<unknown>>>();
           exact<Equal<typeof value, unknown>>();
         });`,
      ]),
      ...[...methods, "prependListener"].flatMap((method) =>
        ["uncaughtException", "uncaughtExceptionMonitor"].map(
          (event) => `${binding}.${method}("${event}", (err, origin) => {
            exact<Equal<typeof err, unknown>>();
            exact<Equal<typeof origin, "uncaughtException" | "unhandledRejection">>();
          });`,
        ),
      ),
    ]);
    writeFileSync(
      entry,
      [
        'import bare from "process";',
        'import prefixed from "node:process";',
        'import { fstat, type StatOptions } from "fs";',
        'import { stat, lstat, type StatSyncOptions } from "node:fs";',
        "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
        "declare function exact<T extends true>(): void;",
        "const options: StatOptions = { bigint: false };",
        "const alias: StatSyncOptions = options;",
        "alias.bigint = true;",
        'stat(".", options, () => {});',
        'lstat(".", alias, () => {});',
        "fstat(0, options, () => {});",
        ...calls,
      ].join("\n"),
    );
    const load = loadProgram(entry);
    try {
      expect(load.typeWorld?.nodeFallback).toBe(true);
      expect(checkPreflight(load)).toEqual([]);
    } finally {
      load.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
