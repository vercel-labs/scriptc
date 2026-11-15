import { afterEach, expect, test, vi } from "vitest";

// Every command is recorded; the built evaluator's probe run gets its answer.
const commands = vi.hoisted(() =>
  vi.fn((file: string) => (file.endsWith("scriptc-comptime.exe") ? '["number","7"]\n' : "")),
);
vi.mock("node:child_process", () => ({ execFileSync: commands }));
vi.mock("node:fs", () => ({
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: () => JSON.stringify({ version: "0.1.7" }),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the Windows build enables every production object target", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64", env: {} });
  await import("../scripts/build.mjs");
  const configure = commands.mock.calls.find(([, args]) => args.includes("-S"));
  expect(configure?.[0]).toBe("cmake");
  const args = configure![1] as string[];
  expect(args.filter((arg) => arg.startsWith("-DSCRIPTC_TARGET_BACKENDS="))).toEqual([
    "-DSCRIPTC_TARGET_BACKENDS=AArch64;X86;WebAssembly",
  ]);
  const targets = args.filter((arg) => arg.startsWith("-DSCRIPTC_ALLOWED_TARGETS="));
  expect(targets).toHaveLength(1);
  expect(targets[0]!.split("=")[1]!.split(",")).toEqual(
    expect.arrayContaining([
      "x86_64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
      "wasm32-unknown-wasi",
      "arm64-apple-ios15.0.0",
      "aarch64-unknown-linux-android26",
    ]),
  );
  // The comptime evaluator is built beside the helper with Zig's Windows GNU
  // target: the engine and the math port are not written for MSVC.
  const zig = commands.mock.calls.filter(([file]) => file === "zig") as [string, string[]][];
  expect(
    zig.every(([, args]) => args.slice(0, 3).join(" ") === "cc -target x86_64-windows-gnu"),
  ).toBe(true);
  const compiled = zig.flatMap(([, args]) => args.filter((arg) => arg.endsWith(".c")));
  expect(compiled.map((path) => path.replaceAll("\\", "/").split("/").at(-1))).toEqual([
    "dtoa.c",
    "libregexp.c",
    "libunicode.c",
    "quickjs.c",
    "scr_ieee754.c",
    "comptime.c",
  ]);
  const link = zig.at(-1)![1];
  expect(link.at(-1)!.replaceAll("\\", "/")).toMatch(/\/bin\/scriptc-comptime\.exe$/);
});
