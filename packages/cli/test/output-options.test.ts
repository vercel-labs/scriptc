import { describe, expect, test } from "vitest";
import { resolveOutputOptions, type OutputOptionValues } from "../src/output-options.js";

const BASE: OutputOptionValues = {
  emitIr: false,
  keepLlvm: true,
  sanitize: false,
};

describe("output option compatibility", () => {
  test.each([
    [undefined, undefined, "exe", "llvm"],
    ["exe", "llvm", "exe", "llvm"],
    ["ir", undefined, "ir", undefined],
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
    [{ emit: "asm", backend: "c" }, /unknown backend/],
    [{ emit: "obj", backend: "c" }, /unknown backend/],
    [{ emit: "c" }, /unknown emit kind/],
    [{ emit: "llvm", backend: "c" }, /unknown backend/],
    [{ emit: "ir", keepLlvm: false }, /no-keep-llvm/],
    [{ emit: "llvm", sanitize: true }, /sanitize/],
    [{ emit: "llvm", optimization: "dev" }, /optimization/],
    [{ emit: "ir", backend: "llvm" }, /before backend selection/],
    [{ emit: "llvm", emitIr: true }, /emit-ir/],
    [{ emit: "ir", emitIr: true }, /same output/],
    [{ backend: "wat" }, /unknown backend/],
    [{ emit: "obj", windowsSubsystem: "gui" }, /windows-subsystem/],
    [{ emit: "llvm", windowsSubsystem: "gui" }, /windows-subsystem/],
    [{ emit: "obj", strip: true }, /strip/],
    [{ emit: "llvm", strip: true }, /strip/],
    [{ emit: "obj", staticLink: true }, /--static/],
    [{ emit: "llvm", staticLink: true }, /--static/],
    [{ emit: "obj", detachedExit: true }, /detached-exit/],
    [{ emit: "llvm", detachedExit: true }, /detached-exit/],
    [{ emit: "obj", largePages: true }, /large-pages/],
    [{ emit: "llvm", largePages: true }, /large-pages/],
    [{ emit: "asm", cpuDispatch: true }, /cpu-dispatch/],
    [{ emit: "obj", profileGenerate: "/tmp/%p.profraw" }, /profile-generate/],
    [{ emit: "llvm", profileUse: "/tmp/a.profdata" }, /profile-use/],
    [{ profileGenerate: "/tmp/%p.profraw", profileUse: "/tmp/a.profdata" }, /cannot be combined/],
  ] as const)("rejects %j", (override, message) => {
    const result = resolveOutputOptions("build", { ...BASE, ...override });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(message) });
  });

  test.each(["ir", "llvm"])("run rejects --emit=%s", (emit) => {
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

  test.each(["asm", "obj"])(
    "native outputs accept optimization and sanitizer for compiler-level validation",
    (emit) => {
      expect(
        resolveOutputOptions("build", {
          ...BASE,
          emit,
          optimization: "dev",
          sanitize: true,
        }),
      ).toMatchObject({ ok: true, outputKind: emit, backend: "llvm" });
    },
  );

  test("the deprecated alias remains additive for executable builds", () => {
    expect(resolveOutputOptions("build", { ...BASE, emitIr: true })).toMatchObject({
      ok: true,
      outputKind: "exe",
      emitIr: true,
      deprecateEmitIr: true,
    });
  });

  test("source outputs retain frontend-affecting FFI manifests", () => {
    expect(
      resolveOutputOptions("build", { ...BASE, emit: "llvm", ffi: "native.json" }),
    ).toMatchObject({
      ok: true,
      outputKind: "llvm",
    });
  });

  test("executable outputs accept a Windows subsystem selection", () => {
    expect(resolveOutputOptions("build", { ...BASE, windowsSubsystem: "gui" })).toMatchObject({
      ok: true,
      outputKind: "exe",
    });
  });

  test("executable outputs accept stripping", () => {
    expect(resolveOutputOptions("build", { ...BASE, strip: true })).toMatchObject({
      ok: true,
      outputKind: "exe",
    });
  });
});
