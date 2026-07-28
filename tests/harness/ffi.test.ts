/* Outbound native FFI is an integration lane rather than a corpus case:
 * Node has no equivalent static-link surface to differential-run. The same
 * TypeScript and native archive run through BOTH scriptc backends, and the
 * result bytes must match. The fixture covers every format-1 ABI class,
 * integer coercion, embedded-NUL/UTF-8 string spans, byte spans, and a void
 * call with observable native state. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile, loadFfiProfile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureRoot = join(repoRoot, "tests/ffi");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const flavor = sanitize ? "san" : "plain";
const cacheRoot = join(
  repoRoot,
  "node_modules/.cache/scriptc-tests/ffi",
  flavor,
);

let cachedNativeArchive: string | undefined;

function nativeArchive(): string {
  if (cachedNativeArchive !== undefined) return cachedNativeArchive;
  const outDir = join(cacheRoot, "native");
  mkdirSync(outDir, { recursive: true });
  const object = join(outDir, "native.o");
  const archive = join(outDir, "libnative.a");
  execFileSync("clang", [
    "-std=c11",
    ...(sanitize ? ["-O1", "-fsanitize=address"] : ["-O2"]),
    "-c",
    join(fixtureRoot, "native.c"),
    "-o",
    object,
  ]);
  execFileSync("ar", ["rcs", archive, object]);
  cachedNativeArchive = archive;
  return cachedNativeArchive;
}

function manifest(archive: string, functionNames?: readonly string[]): string {
  const outDir = join(cacheRoot, "manifest");
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(
    readFileSync(join(fixtureRoot, "profile.json"), "utf8"),
  ) as { functions: { name: string }[]; libraries: string[] };
  if (functionNames !== undefined) {
    const names = new Set(functionNames);
    profile.functions = profile.functions.filter((entry) => names.has(entry.name));
  }
  profile.libraries = [archive];
  const path = join(outDir, "profile.json");
  writeFileSync(path, JSON.stringify(profile, null, 2));
  return path;
}

async function compileScaleFixture(
  id: string,
  body: readonly string[],
  options: {
    backend?: "c" | "llvm";
    emitIr?: boolean;
    ffi?: boolean;
  } = {},
) {
  const outDir = join(cacheRoot, id);
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "main.ts");
  writeFileSync(
    entry,
    [
      "declare function nativeScale(value: number): number;",
      ...body,
      "",
    ].join("\n"),
  );
  const result = await compile(entry, {
    outDir,
    outPath: join(outDir, "program"),
    backend: options.backend ?? "c",
    sanitize,
    ...(options.ffi === false
      ? {}
      : { ffiProfilePath: manifest(nativeArchive(), ["nativeScale"]) }),
    emitIr: options.emitIr,
  });
  return { entry, result };
}

function expectUndefinedAmbient(binaryPath: string): void {
  const native = spawnSync(binaryPath, [], { encoding: "utf8" });
  expect({
    stdout: native.stdout,
    stderr: native.stderr,
    status: native.status,
  }).toEqual({
    stdout: "",
    stderr: "Uncaught ReferenceError: nativeScale is not defined\n",
    status: 1,
  });
}

const expected = [
  "42",
  "true false",
  "2 4294967295 -1",
  "429",
  "6",
  "12.5",
  "",
].join("\n");

describe.each(["c", "llvm"] as const)("outbound native FFI, %s backend", (backend) => {
  test("calls the manifest-bound archive across every v1 ABI class", async () => {
    const outDir = join(cacheRoot, backend);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(fixtureRoot, "main.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      ffiProfilePath: manifest(nativeArchive()),
    });
    if (!result.ok) {
      throw new Error(
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      );
    }
    expect(
      execFileSync(result.binaryPath, [], { encoding: "utf8" }),
    ).toBe(expected);
  });
});

describe.each(["c", "llvm"] as const)("FFI binding initializers, %s backend", (backend) => {
  test("preserves exact calls across binding and early-probe contexts", async () => {
    const { result } = await compileScaleFixture(
      `binding-initializer-${backend}`,
      [
        "const moduleResult = nativeScale(2);",
        "function main(): void {",
        "  const functionResult = nativeScale(21);",
        "  let once = nativeScale(3);",
        "  console.log('module:', moduleResult);",
        "  console.log('const:', functionResult);",
        "  console.log('let:', once);",
        "  for (const value of [1, 2]) {",
        "    const loopResult = nativeScale(value);",
        "    console.log('loop:', loopResult);",
        "  }",
        "  let assigned = 0;",
        "  assigned = nativeScale(5);",
        "  console.log('assignment:', assigned);",
        "  const text = nativeScale(6).toString();",
        "  console.log('chain:', text);",
        "  let calls = 0;",
        "  const sideEffectResult = nativeScale(++calls);",
        "  console.log('side effect:', sideEffectResult, calls);",
        "}",
        "main();",
      ],
      { backend, emitIr: true },
    );
    if (!result.ok) {
      throw new Error(
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      );
    }

    const native = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect({
      stdout: native.stdout,
      stderr: native.stderr,
      status: native.status,
    }).toEqual({
      stdout: [
        "module: 4",
        "const: 42",
        "let: 6",
        "loop: 2",
        "loop: 4",
        "assignment: 10",
        "chain: 12",
        "side effect: 2 1",
        "",
      ].join("\n"),
      stderr: "",
      status: 0,
    });

    const ir = JSON.stringify(JSON.parse(readFileSync(result.irPath!, "utf8")));
    expect(ir.match(/"kind":"ffiCall"/g)).toHaveLength(7);
    expect(ir).not.toContain('"fn":"global.undefRead"');
  });
});

test("keeps a no-manifest ambient initializer failure ahead of its arguments", async () => {
  const { result } = await compileScaleFixture(
    "binding-initializer-no-manifest",
    [
      "function argument(): number {",
      "  console.log('argument evaluated');",
      "  return 21;",
      "}",
      "const result = nativeScale(argument());",
      "console.log(result);",
    ],
    { emitIr: true, ffi: false },
  );
  if (!result.ok) {
    throw new Error(
      result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }

  expectUndefinedAmbient(result.binaryPath);

  const ir = JSON.stringify(JSON.parse(readFileSync(result.irPath!, "utf8")));
  expect(ir).toContain('"fn":"global.undefRead"');
  expect(ir).not.toContain('"kind":"ffiCall"');
});

test.each([
  {
    id: "alias",
    name: "an alias read",
    body: [
      "const alias = nativeScale;",
      "console.log(alias(21));",
    ],
  },
  {
    id: "call-property",
    name: "a .call use",
    body: ["console.log(nativeScale.call(null, 21));"],
  },
  {
    id: "parenthesized-callee",
    name: "a parenthesized callee",
    body: ["console.log((nativeScale)(21));"],
  },
])("does not widen $name into a native call", async ({ id, body }) => {
  const { result } = await compileScaleFixture(`indirect-${id}`, body);
  if (!result.ok) {
    throw new Error(
      result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }

  expectUndefinedAmbient(result.binaryPath);
});

test.each([
  {
    id: "optional",
    name: "an optional direct call",
    call: "nativeScale?.(21)",
    message: "direct, non-generic calls only",
  },
  {
    id: "spread",
    name: "a spread direct call",
    call: "nativeScale(...([21] as [number]))",
    message: "spread arguments do not have a fixed native ABI",
  },
  {
    id: "arity",
    name: "a wrong-arity direct call",
    call: "nativeScale()",
    message: "native ABI requires exactly 1",
    suppressTypeScript: true,
  },
])("keeps the existing FFI diagnostic for $name", async ({
  id,
  call,
  message,
  suppressTypeScript,
}) => {
  const { entry, result } = await compileScaleFixture(
    `call-diagnostic-${id}`,
    [
      "function main(): void {",
      ...(suppressTypeScript ? ["  // @ts-ignore exercise the native arity diagnostic"] : []),
      `  const result = ${call};`,
      "}",
      "main();",
    ],
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("SC5003");
    expect(result.diagnostics[0]?.message).toContain(message);
    expect(result.diagnostics[0]?.loc.file).toBe(entry);
  }
});

test("manifest validation is strict and source-facing", () => {
  const path = join(cacheRoot, "invalid.json");
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      ffi_format: 1,
      functions: [
        { name: "f", symbol: "not-a-C-symbol", params: [], returns: "f64" },
      ],
    }),
  );
  const result = loadFfiProfile(path);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostics[0]?.code).toBe("SC5001");
    expect(result.diagnostics[0]?.message).toContain("not a C identifier");
  }
});

test("manifest validation reports a missing native link input", () => {
  const path = join(cacheRoot, "missing-library.json");
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      ffi_format: 1,
      functions: [],
      libraries: ["does-not-exist.a"],
    }),
  );
  const result = loadFfiProfile(path);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostics[0]?.code).toBe("SC5001");
    expect(result.diagnostics[0]?.message).toContain("cannot be read");
  }
});

test.each([
  {
    id: "called-signature",
    name: "a TypeScript signature that disagrees with the manifest",
    source: [
      "declare function nativeScale(value: string): number;",
      "console.log(nativeScale('21'));",
      "",
    ].join("\n"),
    code: "SC5003",
    message: "parameter 1",
  },
  {
    id: "called-body",
    name: "an ordinary function body with a configured name",
    source: [
      "function nativeScale(value: number): number { return value; }",
      "console.log(nativeScale(21));",
      "",
    ].join("\n"),
    code: "SC5002",
    message: "signature-only",
  },
  {
    id: "unused-signature",
    name: "an unused TypeScript signature that disagrees with the manifest",
    source: [
      "declare function nativeScale(value: string): number;",
      "console.log('ok');",
      "",
    ].join("\n"),
    code: "SC5003",
    message: "parameter 1",
  },
  {
    id: "unused-missing",
    name: "an unused manifest binding with no source declaration",
    source: [
      "console.log('ok');",
      "",
    ].join("\n"),
    code: "SC5002",
    message: "signature-only",
  },
  {
    id: "never-parameter",
    name: "an uninhabited TypeScript parameter presented as a native ABI slot",
    source: [
      "declare function nativeScale(value: never): number;",
      "console.log('ok');",
      "",
    ].join("\n"),
    code: "SC5003",
    message: "parameter 1 is 'never'",
  },
  {
    id: "never-return",
    name: "a TypeScript never return that the native function cannot uphold",
    source: [
      "declare function nativeScale(value: number): never;",
      "console.log('ok');",
      "",
    ].join("\n"),
    code: "SC5003",
    message: "return type is 'never'",
  },
])("rejects $name", async ({ id, source, code, message }) => {
  const outDir = join(cacheRoot, `reject-${id}`);
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "main.ts");
  const profilePath = join(outDir, "profile.json");
  writeFileSync(entry, source);
  writeFileSync(
    profilePath,
    JSON.stringify({
      ffi_format: 1,
      functions: [
        {
          name: "nativeScale",
          symbol: "sf_scale",
          params: ["f64"],
          returns: "f64",
        },
      ],
    }),
  );
  const result = await compile(entry, {
    outDir,
    outPath: join(outDir, "never"),
    ffiProfilePath: profilePath,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostics[0]?.code).toBe(code);
    expect(result.diagnostics[0]?.message).toContain(message);
  }
});

describe.each(["c", "llvm"] as const)("FFI binding identity, %s backend", (backend) => {
  test("a local same-named function remains ordinary TypeScript with Node-byte parity", async () => {
    const outDir = join(cacheRoot, `shadow-${backend}`);
    mkdirSync(outDir, { recursive: true });
    // Node 24 deliberately refuses its built-in TypeScript stripping for
    // files below node_modules, where this suite keeps compiler artifacts.
    // Keep the reference input in the OS temp tree and only outputs/cache in
    // node_modules.
    const sourceDir = mkdtempSync(join(tmpdir(), "scriptc-ffi-shadow-"));
    const entry = join(sourceDir, "main.ts");
    const profilePath = join(outDir, "profile.json");
    try {
      writeFileSync(
        entry,
        [
          "declare function nativeScale(value: number): number;",
          "function localUse(): number {",
          "  function nativeScale(value: number): number { return value + 1; }",
          "  const result = nativeScale(21);",
          "  return result;",
          "}",
          "console.log(localUse());",
          "",
        ].join("\n"),
      );
      writeFileSync(
        profilePath,
        JSON.stringify({
          ffi_format: 1,
          functions: [
            {
              name: "nativeScale",
              symbol: "sf_scale",
              params: ["f64"],
              returns: "f64",
            },
          ],
          libraries: [nativeArchive()],
        }),
      );

      const result = await compile(entry, {
        outDir,
        outPath: join(outDir, "program"),
        backend,
        sanitize,
        ffiProfilePath: profilePath,
      });
      if (!result.ok) {
        throw new Error(
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
        );
      }

      const node = spawnSync(process.execPath, [entry], { encoding: "utf8" });
      const native = spawnSync(result.binaryPath, [], { encoding: "utf8" });
      expect({
        stdout: native.stdout,
        stderr: native.stderr,
        status: native.status,
      }).toEqual({
        stdout: node.stdout,
        stderr: node.stderr,
        status: node.status,
      });
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

test("a missing FFI symbol is an SC5004 diagnostic, not a rejected compile", async () => {
  const outDir = join(cacheRoot, "missing-symbol");
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "main.ts");
  const profilePath = join(outDir, "profile.json");
  const missingSymbol = "sf_symbol_that_does_not_exist";
  writeFileSync(
    entry,
    [
      "declare function nativeScale(value: number): number;",
      "console.log(nativeScale(21));",
      "",
    ].join("\n"),
  );
  writeFileSync(
    profilePath,
    JSON.stringify({
      ffi_format: 1,
      functions: [
        {
          name: "nativeScale",
          symbol: missingSymbol,
          params: ["f64"],
          returns: "f64",
        },
      ],
      libraries: [nativeArchive()],
    }),
  );

  const result = await compile(entry, {
    outDir,
    outPath: join(outDir, "program"),
    sanitize,
    ffiProfilePath: profilePath,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("SC5004");
    expect(result.diagnostics[0]?.message).toContain(missingSymbol);
    expect(result.diagnostics[0]?.message).not.toContain("CcCompileError");
  }
});
