/* Outbound native FFI is an integration lane rather than a corpus case:
 * Node has no equivalent static-link surface to differential-run. The same
 * TypeScript and native archive run through BOTH scriptc backends, and the
 * result bytes must match. The fixture covers every value ABI class,
 * integer coercion, embedded-NUL/UTF-8 string spans, byte spans, format-2
 * raw/context callbacks, format-3 callback cstring/span copies (lossy UTF-8,
 * exact bytes, empty spans, ownership, and catchable throws), and format-4
 * retained registration/release ownership. */
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

function nativeArchive(): string {
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
  return archive;
}

function manifest(archive: string): string {
  const outDir = join(cacheRoot, "manifest");
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(
    readFileSync(join(fixtureRoot, "profile.json"), "utf8"),
  ) as { libraries: string[] };
  profile.libraries = [archive];
  const path = join(outDir, "profile.json");
  writeFileSync(path, JSON.stringify(profile, null, 2));
  return path;
}

const expected = [
  "42",
  "true false",
  "2 4294967295 -1",
  "429",
  "6",
  "12.5",
  "12",
  "28",
  "9",
  "42",
  "true 255 4000000000 -7 0.5",
  "4294967295",
  "6",
  "1:alpha|2:café|3:bad:�(",
  "0 NaN  ",
  "4 0 Bé 0,255,1",
  "caught callback boom",
  "first:11|second:1|second:3",
  "7",
  "caught retained boom 9",
  "4",
  "6 20",
  "caught string callback boom: materialized",
  "",
].join("\n");

describe.each(["c", "llvm"] as const)("outbound native FFI, %s backend", (backend) => {
  test("calls the manifest-bound archive across every v1 ABI class plus v2/v3/v4 callback ABI classes", async () => {
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

  test("traps a NULL callback cstring with a precise boundary error", async () => {
    const outDir = join(cacheRoot, `null-cstring-${backend}`);
    mkdirSync(outDir, { recursive: true });
    const entry = join(outDir, "main.ts");
    const profilePath = join(outDir, "profile.json");
    writeFileSync(
      entry,
      [
        "declare function nativeNullCString(callback: (value: string) => void): void;",
        "nativeNullCString((value) => console.log(value));",
        "",
      ].join("\n"),
    );
    writeFileSync(
      profilePath,
      JSON.stringify({
        ffi_format: 3,
        functions: [{
          name: "nativeNullCString",
          symbol: "sf_null_cstring",
          params: [{
            callback: {
              id: "nullCString",
              params: ["cstring", { context: "nullCString" }],
              returns: "void",
              lifetime: "call",
            },
          }, { context: "nullCString" }],
          returns: "void",
        }],
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
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("scriptc: native callback passed a NULL cstring");
  });
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
    name: "a callback in format 1",
    profile: {
      ffi_format: 1,
      functions: [{
        name: "visit",
        symbol: "sf_visit",
        params: [{ callback: { id: "visit", params: ["f64"], returns: "void", lifetime: "call" } }],
        returns: "void",
      }],
    },
    message: "must be one of",
  },
  {
    name: "an orphaned context",
    profile: {
      ffi_format: 2,
      functions: [{ name: "visit", symbol: "sf_visit", params: [{ context: "visit" }], returns: "void" }],
    },
    message: "has no matching callback",
  },
  {
    name: "a context present on only one side",
    profile: {
      ffi_format: 2,
      functions: [{
        name: "visit",
        symbol: "sf_visit",
        params: [{
          callback: {
            id: "visit",
            params: ["f64", { context: "visit" }],
            returns: "void",
            lifetime: "call",
          },
        }],
        returns: "void",
      }],
    },
    message: "exactly once in both",
  },
  {
    name: "a retained callback lifetime",
    profile: {
      ffi_format: 2,
      functions: [{
        name: "visit",
        symbol: "sf_visit",
        params: [{
          callback: { id: "visit", params: ["f64"], returns: "void", lifetime: "retained" },
        }],
        returns: "void",
      }],
    },
    message: "value 'retained' requires ffi_format 4",
  },
  {
    name: "a format 3 callback class in format 2",
    profile: {
      ffi_format: 2,
      functions: [{
        name: "visit",
        symbol: "sf_visit",
        params: [{
          callback: { id: "visit", params: ["cstring"], returns: "void", lifetime: "call" },
        }],
        returns: "void",
      }],
    },
    message: "class 'cstring' requires ffi_format 3",
  },
  {
    name: "cstring as a callback return",
    profile: {
      ffi_format: 3,
      functions: [{
        name: "visit",
        symbol: "sf_visit",
        params: [{
          callback: { id: "visit", params: [], returns: "cstring", lifetime: "call" },
        }],
        returns: "void",
      }],
    },
    message: "callback.returns' must be one of",
  },
  {
    name: "cstring as an outer parameter",
    profile: {
      ffi_format: 3,
      functions: [{ name: "visit", symbol: "sf_visit", params: ["cstring"], returns: "void" }],
    },
    message: "must be one of",
  },
  {
    name: "a release descriptor before format 4",
    profile: {
      ffi_format: 3,
      functions: [{
        name: "remove",
        symbol: "sf_remove",
        params: [{ callback: { release: "add:tick" } }],
        returns: "void",
      }],
    },
    message: "callback.release' requires ffi_format 4",
  },
  {
    name: "a dangling retained release",
    profile: {
      ffi_format: 4,
      functions: [{
        name: "remove",
        symbol: "sf_remove",
        params: [{ callback: { release: "missing:tick" } }],
        returns: "void",
      }],
    },
    message: "has no matching retained callback",
  },
  {
    name: "a release targeting a call-scoped callback",
    profile: {
      ffi_format: 4,
      functions: [{
        name: "add",
        symbol: "sf_add",
        params: [{ callback: { id: "tick", params: [], returns: "void", lifetime: "call" } }],
        returns: "void",
      }, {
        name: "remove",
        symbol: "sf_remove",
        params: [{ callback: { release: "add:tick" } }],
        returns: "void",
      }],
    },
    message: "targets a non-retained callback",
  },
  {
    name: "a release carrying its own signature",
    profile: {
      ffi_format: 4,
      functions: [{
        name: "remove",
        symbol: "sf_remove",
        params: [{ callback: { release: "add:tick", params: [] } }],
        returns: "void",
      }],
    },
    message: "unknown field 'functions[0].params[0].callback.params'",
  },
])("manifest validation rejects $name", ({ name, profile, message }) => {
  const path = join(cacheRoot, `invalid-callback-${name.replaceAll(" ", "-")}.json`);
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(path, JSON.stringify(profile));
  const result = loadFfiProfile(path);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostics[0]?.code).toBe("SC5001");
    expect(result.diagnostics[0]?.message).toContain(message);
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
  {
    id: "narrow-return",
    name: "a narrowed TypeScript return that does not cover the native ABI domain",
    source: [
      "declare function nativeScale(value: number): 0;",
      "console.log('ok');",
      "",
    ].join("\n"),
    code: "SC5003",
    message: "may supply any number",
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

test.each([
  { id: "number-literal", type: "0", nativeClass: "f64", domain: "number", prefix: null },
  {
    id: "numeric-enum",
    type: "NativeValue",
    nativeClass: "f64",
    domain: "number",
    prefix: "enum NativeValue { Zero }",
  },
  { id: "never", type: "never", nativeClass: "f64", domain: "number", prefix: null },
  { id: "boolean-literal", type: "true", nativeClass: "bool", domain: "boolean", prefix: null },
  { id: "string-literal", type: '"fixed"', nativeClass: "cstring", domain: "string", prefix: null },
  { id: "span-string-literal", type: '"fixed"', nativeClass: "string", domain: "string", prefix: null },
])(
  "rejects a narrowed $id native-to-script callback parameter",
  async ({ id, type, nativeClass, domain, prefix }) => {
    const outDir = join(cacheRoot, `reject-callback-${id}`);
    mkdirSync(outDir, { recursive: true });
    const entry = join(outDir, "main.ts");
    const profilePath = join(outDir, "profile.json");
    writeFileSync(
      entry,
      [
        ...(prefix === null ? [] : [prefix]),
        `declare function nativeVisit(callback: (value: ${type}) => void): void;`,
        "console.log('ok');",
        "",
      ].join("\n"),
    );
    writeFileSync(
      profilePath,
      JSON.stringify({
        ffi_format: nativeClass === "cstring" || nativeClass === "string" ? 3 : 2,
        functions: [{
          name: "nativeVisit",
          symbol: "sf_visit",
          params: [{
            callback: {
              id: "visit",
              params: [nativeClass],
              returns: "void",
              lifetime: "call",
            },
          }],
          returns: "void",
        }],
      }),
    );

    const result = await compile(entry, {
      outDir,
      outPath: join(outDir, "program"),
      ffiProfilePath: profilePath,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe("SC5003");
      expect(result.diagnostics[0]?.message).toContain(
        `callback 'visit' parameter 1 is '${type}'`,
      );
      expect(result.diagnostics[0]?.message).toContain(`declare it as '${domain}'`);
    }
  },
);

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
          "  return nativeScale(21);",
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

describe.each(["c", "llvm"] as const)("retained FFI release traps, %s backend", (backend) => {
  test("releasing a closure that was never registered traps precisely", async () => {
    const outDir = join(cacheRoot, `retained-missing-${backend}`);
    mkdirSync(outDir, { recursive: true });
    const entry = join(outDir, "main.ts");
    const profilePath = join(outDir, "profile.json");
    writeFileSync(
      entry,
      [
        "declare function nativeRetainedAdd(callback: (value: number) => void): void;",
        "declare function nativeRetainedRemove(callback: (value: number) => void): void;",
        "const registered = (_value: number) => {};",
        "const missing = (_value: number) => {};",
        "nativeRetainedAdd(registered);",
        "nativeRetainedRemove(missing);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      profilePath,
      JSON.stringify({
        ffi_format: 4,
        functions: [{
          name: "nativeRetainedAdd",
          symbol: "sf_retained_add",
          params: [{
            callback: {
              id: "tick",
              params: ["f64", { context: "tick" }],
              returns: "void",
              lifetime: "retained",
            },
          }, { context: "tick" }],
          returns: "void",
        }, {
          name: "nativeRetainedRemove",
          symbol: "sf_retained_remove",
          params: [{ callback: { release: "nativeRetainedAdd:tick" } }, {
            context: "nativeRetainedAdd:tick",
          }],
          returns: "void",
        }],
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
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(
      "scriptc: releasing a native callback registration that does not exist",
    );
  });
});

test("retained callback calls reject function adapters that would change identity", async () => {
  const outDir = join(cacheRoot, "retained-adapter-identity");
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "main.ts");
  const profilePath = join(outDir, "profile.json");
  writeFileSync(
    entry,
    [
      "declare function nativeRetainedRawSet(callback: (value: number) => void): void;",
      "const returnsNumber = (value: number) => value;",
      "nativeRetainedRawSet(returnsNumber);",
      "",
    ].join("\n"),
  );
  writeFileSync(
    profilePath,
    JSON.stringify({
      ffi_format: 4,
      functions: [{
        name: "nativeRetainedRawSet",
        symbol: "sf_retained_raw_set",
        params: [{
          callback: {
            id: "raw",
            params: ["f64"],
            returns: "void",
            lifetime: "retained",
          },
        }],
        returns: "void",
      }],
      libraries: [nativeArchive()],
    }),
  );
  const result = await compile(entry, {
    outDir,
    outPath: join(outDir, "program"),
    ffiProfilePath: profilePath,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostics[0]?.code).toBe("SC5003");
    expect(result.diagnostics[0]?.message).toContain("would change its release identity");
  }
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
