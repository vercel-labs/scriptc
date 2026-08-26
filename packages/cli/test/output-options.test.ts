import { describe, expect, test } from "vitest";
import { resolveOutputOptions, type OutputOptionValues } from "../src/output-options.js";

const BASE: OutputOptionValues = {
  emitIr: false,
  fromC: false,
  keepC: true,
  sanitize: false,
};

describe("output option compatibility", () => {
  test.each([
    [undefined, undefined, "exe", undefined],
    ["exe", "c", "exe", "c"],
    ["ir", undefined, "ir", undefined],
    ["c", undefined, "c", "c"],
    ["c", "c", "c", "c"],
    ["llvm", undefined, "llvm", "llvm"],
    ["llvm", "llvm", "llvm", "llvm"],
    ["asm", undefined, "asm", "llvm"],
    ["obj", "llvm", "obj", "llvm"],
  ] as const)("accepts --emit=%s --backend=%s", (emit, backend, outputKind, expectedBackend) => {
    const result = resolveOutputOptions("build", {
      ...BASE,
      ...(emit === undefined ? {} : { emit }),
      ...(backend === undefined ? {} : { backend }),
    });
    expect(result).toMatchObject({
      ok: true,
      outputKind,
      ...(expectedBackend === undefined ? {} : { backend: expectedBackend }),
    });
  });

  test.each([
    [{ emit: "wat" }, /unknown emit kind/],
    [{ emit: "asm", backend: "c" }, /cannot be combined/],
    [{ emit: "obj", backend: "c" }, /cannot be combined/],
    [{ emit: "c", backend: "llvm" }, /cannot be combined/],
    [{ emit: "llvm", backend: "c" }, /cannot be combined/],
    [{ emit: "ir", keepC: false }, /no-keep-c/],
    [{ emit: "c", sanitize: true }, /sanitize/],
    [{ emit: "llvm", optimization: "dev" }, /optimization/],
    [{ emit: "ir", backend: "c" }, /before backend selection/],
    [{ emit: "ir", fromC: true }, /from-c/],
    [{ emit: "llvm", emitIr: true }, /emit-ir/],
    [{ emit: "ir", emitIr: true }, /same output/],
    [{ backend: "wat" }, /unknown backend/],
  ] as const)("rejects %j", (override, message) => {
    const result = resolveOutputOptions("build", { ...BASE, ...override });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(message) });
  });

  test.each(["ir", "c", "llvm"])("run rejects --emit=%s", (emit) => {
    expect(resolveOutputOptions("run", { ...BASE, emit })).toEqual({
      ok: false,
      message: "scriptc run requires --emit=exe",
    });
  });

  test.each(["asm", "obj"])("run rejects --emit=%s", (emit) => {
    expect(resolveOutputOptions("run", { ...BASE, emit })).toEqual({
      ok: false,
      message: "scriptc run requires --emit=exe",
    });
  });

  test.each(["asm", "obj"])("native outputs accept optimization and sanitizer for compiler-level validation", (emit) => {
    expect(resolveOutputOptions("build", {
      ...BASE,
      emit,
      optimization: "dev",
      sanitize: true,
    })).toMatchObject({ ok: true, outputKind: emit, backend: "llvm" });
  });

  test("the deprecated alias remains additive for executable builds", () => {
    expect(resolveOutputOptions("build", { ...BASE, emitIr: true })).toMatchObject({
      ok: true,
      outputKind: "exe",
      emitIr: true,
      deprecateEmitIr: true,
    });
  });

  test("source outputs retain frontend-affecting FFI manifests", () => {
    expect(resolveOutputOptions("build", { ...BASE, emit: "llvm", ffi: "native.json" })).toMatchObject({
      ok: true,
      outputKind: "llvm",
    });
  });
});
