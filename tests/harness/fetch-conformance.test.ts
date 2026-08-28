/**
 * Generated, version-pinned conformance for the engine-free fetch slice.
 *
 * The compatibility profile is compiler input, not test-only metadata: its
 * member allowlists drive lowering and its entries project into the shipped
 * surface manifest. The reflected inventory supplies the denominator. This
 * suite checks that the pinned Node executable is the intended oracle, every
 * profile row names differential evidence, and the generated
 * WebIDL/state-machine program agrees through both native backends.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import {
  compile,
  NODE24_FETCH_COMPAT_PROFILE,
  renderDiagnostics,
  type FetchCompatEvidence,
} from "@scriptc/compiler";
import {
  FETCH_CONFORMANCE_SCENARIOS,
  FETCH_CONFORMANCE_SEED,
  generateFetchConformanceProgram,
  generatedScenarioIds,
} from "./fetch-conformance-program.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures/fetch");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const profile = NODE24_FETCH_COMPAT_PROFILE;
function configuredInteger(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

const conformanceSeed = configuredInteger(
  "SCRIPTC_FETCH_CONFORMANCE_SEED",
  FETCH_CONFORMANCE_SEED,
  0xffff_ffff,
);
const conformanceTraceCount = configuredInteger(
  "SCRIPTC_FETCH_CONFORMANCE_TRACES",
  12,
  100,
);
const generatedSource = generateFetchConformanceProgram(profile, {
  seed: conformanceSeed,
  traceCount: conformanceTraceCount,
});
const sourceHash = createHash("sha256")
  .update(generatedSource)
  .digest("hex")
  .slice(0, 16);
const workRoot = mkdtempSync(join(tmpdir(), "scriptc-fetch-conformance-"));
const entry = join(workRoot, "main.js");

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

function normalizedStderr(result: RunResult): string {
  const stderr = result.stderr.toString("utf8");
  if (!sanitize) return stderr;
  // Linux ASan prints this once per process at the runtime's first fiber
  // context switch. It has no suppression switch and is harness noise, not
  // program stderr; retain every other byte so real sanitizer reports fail.
  return stderr.replace(
    /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
    "",
  );
}

async function run(command: string, args: string[]): Promise<RunResult> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "buffer",
      env: process.env,
      timeout: 30_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      code?: unknown;
      stdout?: Buffer;
      stderr?: Buffer;
    };
    if (
      typeof failure.code !== "number" ||
      !Buffer.isBuffer(failure.stdout) ||
      !Buffer.isBuffer(failure.stderr)
    ) {
      throw error;
    }
    return {
      stdout: failure.stdout,
      stderr: failure.stderr,
      exitCode: failure.code,
    };
  }
}

async function build(backend: "c" | "llvm"): Promise<string> {
  const outDir = join(
    workRoot,
    `${sourceHash}-${backend}-${sanitize ? "san" : "plain"}`,
  );
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outDir,
    outPath: join(outDir, "program"),
    backend,
    sanitize,
  });
  if (!result.ok) {
    expect.unreachable(
      `generated fetch conformance program failed to compile (${backend}):\n` +
        renderDiagnostics(result.diagnostics, result.sourceTexts, { color: false }) +
        `\ngenerated source: ${entry}`,
    );
  }
  return result.binaryPath;
}

function evidenceKey(evidence: FetchCompatEvidence): string {
  if (evidence.generated !== undefined && evidence.fixture === undefined) {
    return `generated:${evidence.generated}`;
  }
  if (evidence.fixture !== undefined && evidence.generated === undefined) {
    return `fixture:${evidence.fixture}`;
  }
  throw new Error("fetch profile evidence must name exactly one source");
}

interface RuntimeInterfaceSurface {
  statics: string[];
  prototype: string[];
  inherited: string[];
  symbols: string[];
}

const publicWellKnownSymbols = new Map<symbol, string>();
for (const name of Object.getOwnPropertyNames(Symbol)) {
  const value = (Symbol as unknown as Record<string, unknown>)[name];
  if (typeof value === "symbol") {
    publicWellKnownSymbols.set(value, `[Symbol.${name}]`);
  }
}

function publicSymbolName(symbol: symbol): string | null {
  const publicName = publicWellKnownSymbols.get(symbol);
  if (publicName !== undefined) return publicName;
  // Node-private transfer/inspection symbols are implementation details,
  // not the public WebIDL surface this profile promises to classify.
  return null;
}

function runtimeInterfaceSurface(name: string): RuntimeInterfaceSurface {
  const value = (globalThis as unknown as Record<string, unknown>)[name];
  expect(typeof value, `${name} must be a global constructor object`).toBe("function");
  const ctor = value as Function & { prototype: object };
  const prototype = ctor.prototype;
  const ownNames = Object.getOwnPropertyNames(prototype)
    .filter((member) => member !== "constructor");
  const inherited: string[] = [];
  const visibleNames = new Set(ownNames);
  const symbols: string[] = [];
  const visibleSymbols = new Set<symbol>();

  for (let current: object | null = prototype;
    current !== null && current !== Object.prototype;
    current = Object.getPrototypeOf(current) as object | null) {
    if (current !== prototype) {
      for (const member of Object.getOwnPropertyNames(current)) {
        if (member === "constructor" || visibleNames.has(member)) continue;
        visibleNames.add(member);
        inherited.push(member);
      }
    }
    for (const symbol of Object.getOwnPropertySymbols(current)) {
      if (visibleSymbols.has(symbol)) continue;
      visibleSymbols.add(symbol);
      const member = publicSymbolName(symbol);
      if (member !== null) symbols.push(member);
    }
  }

  return {
    statics: Object.getOwnPropertyNames(ctor)
      .filter((member) => !["length", "name", "prototype"].includes(member)),
    prototype: ownNames,
    inherited,
    symbols,
  };
}

function dictionaryReads(construct: (init: object) => unknown): string[] {
  const reads: string[] = [];
  const init = new Proxy({}, {
    get(_target, key) {
      reads.push(String(key));
      return undefined;
    },
  });
  construct(init);
  return [...new Set(reads)];
}

beforeAll(() => {
  writeFileSync(entry, generatedSource);
});

describe("Node 24 fetch compatibility profile", () => {
  test("the running oracle is the exact pinned Node/Undici tuple", () => {
    const pinnedNode = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
    expect(profile.target.node).toBe(pinnedNode);
    expect(process.versions.node).toBe(profile.target.node);
    expect(process.versions.undici).toBe(profile.target.undici);
  });

  test("the inventory classifies every supported row and every gap", () => {
    const supported = [...profile.operations, ...profile.requestInit, ...profile.responseInit]
      .map((row) => row.id)
      .sort();
    const entries = profile.inventory.entries;
    const ids = entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      entries.filter((entry) => entry.status === "static").map((entry) => entry.id).sort(),
    ).toEqual(supported);

    for (const entry of entries) {
      if (entry.status === "static") {
        expect(entry.code, `${entry.id}: static rows have no refusal code`).toBeUndefined();
        expect(entry.reason, `${entry.id}: static rows are explained by evidence`).toBeUndefined();
      } else if (entry.status === "dynamic-only" || entry.status === "unsupported") {
        expect(entry.code, `${entry.id}: non-static rows use the stdlib fence`).toBe("SC2020");
        expect(entry.reason?.length, `${entry.id}: missing gap rationale`).toBeGreaterThan(0);
      } else {
        expect(entry.code, `${entry.id}: exclusions are not refusal claims`).toBeUndefined();
        expect(entry.reason?.length, `${entry.id}: missing scope rationale`).toBeGreaterThan(0);
      }
    }

    expect(entries.some((entry) => entry.status === "dynamic-only")).toBe(true);
    expect(entries.some((entry) => entry.status === "unsupported")).toBe(true);
    expect(entries.some((entry) => entry.status === "out-of-scope")).toBe(true);
    expect(profile.inventory.excludedInterfaces.length).toBeGreaterThan(0);
    for (const exclusion of profile.inventory.excludedInterfaces) {
      expect(exclusion.name.length).toBeGreaterThan(0);
      expect(exclusion.reason.length).toBeGreaterThan(0);
    }
  });

  test("the selected runtime interfaces match the complete public census", () => {
    const entries = profile.inventory.entries;
    const expected = (owner: string, placement: string): string[] =>
      entries
        .filter((entry) => entry.owner === owner && entry.placement === placement)
        .map((entry) => entry.member)
        .sort();

    for (const owner of profile.inventory.interfaces) {
      expect(
        entries.filter((entry) =>
          entry.owner === owner && entry.placement === "constructor"
        ).length,
        `${owner}: constructor classification`,
      ).toBe(1);
      const actual = runtimeInterfaceSurface(owner);
      expect(actual.statics.sort(), `${owner}: static members`).toEqual(expected(owner, "static"));
      expect(actual.prototype.sort(), `${owner}: own prototype members`).toEqual(
        expected(owner, "prototype"),
      );
      expect(actual.inherited.sort(), `${owner}: inherited prototype members`).toEqual(
        expected(owner, "prototype-inherited"),
      );
      expect(actual.symbols.sort(), `${owner}: public symbol members`).toEqual(
        expected(owner, "prototype-symbol"),
      );
    }
    expect(typeof globalThis.fetch).toBe("function");
  });

  test("the public-symbol classifier covers every well-known symbol", () => {
    expect(publicWellKnownSymbols.size).toBeGreaterThan(0);
    for (const [symbol, name] of publicWellKnownSymbols) {
      expect(publicSymbolName(symbol)).toBe(name);
    }
    expect(publicSymbolName(Symbol("nodejs.private"))).toBeNull();
  });

  test("the WebIDL dictionary census matches Node's conversion reads", () => {
    const expected = (owner: string): string[] =>
      profile.inventory.entries
        .filter((entry) => entry.owner === owner && entry.placement === "dictionary")
        .map((entry) => entry.member);
    expect(dictionaryReads((init) =>
      new Request("http://example.com", init as RequestInit)
    )).toEqual(expected("RequestInit"));
    expect(dictionaryReads((init) =>
      new Response(null, init as ResponseInit)
    )).toEqual(expected("ResponseInit"));
  });

  test("every row has unique ids and resolvable differential evidence", () => {
    expect(profile.schemaVersion).toBe(1);
    const rows = [...profile.operations, ...profile.requestInit, ...profile.responseInit];
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(profile.operations.length).toBeGreaterThanOrEqual(35);

    for (const row of rows) {
      expect(row.evidence.length, `${row.id}: missing differential evidence`).toBeGreaterThan(0);
      for (const evidence of row.evidence) {
        const key = evidenceKey(evidence);
        if (evidence.generated !== undefined) {
          expect(
            FETCH_CONFORMANCE_SCENARIOS,
            `${row.id}: unknown generated scenario ${key}`,
          ).toContain(evidence.generated);
        } else {
          const root = join(fixturesRoot, evidence.fixture!);
          expect(
            existsSync(join(root, "main.js")) || existsSync(join(root, "main.mts")),
            `${row.id}: missing ${key}`,
          ).toBe(true);
        }
      }
    }
  });

  test("the profile member allowlists have matching operation rows", () => {
    for (const member of [
      ...profile.members.responseReads,
      ...profile.members.responseCalls,
    ]) {
      expect(
        profile.operations.some((operation) =>
          operation.name === `Response.${member}`
        ),
        `Response.${member} has no compatibility row`,
      ).toBe(true);
    }
    for (const member of [
      ...profile.members.readableStreamReads,
      ...profile.members.readableStreamCalls,
    ]) {
      expect(
        profile.operations.some((operation) =>
          operation.name === `ReadableStream.${member}`
        ),
        `ReadableStream.${member} has no compatibility row`,
      ).toBe(true);
    }
  });

  test("generation is deterministic and covers every registered scenario", () => {
    expect(generateFetchConformanceProgram(profile, {
      seed: conformanceSeed,
      traceCount: conformanceTraceCount,
    })).toBe(generatedSource);
    expect(generatedScenarioIds(profile)).toEqual(
      [...FETCH_CONFORMANCE_SCENARIOS].sort(),
    );
    for (const scenario of FETCH_CONFORMANCE_SCENARIOS) {
      expect(generatedSource).toContain(`// scenario: ${scenario}`);
    }
  });
});

describe(
  `generated fetch conformance (seed=${conformanceSeed}, traces=${conformanceTraceCount}` +
    `${sanitize ? ", sanitized" : ""})`,
  () => {
    test.for(["c", "llvm"] as const)(
      "%s backend matches the pinned Node oracle",
      async (backend) => {
        const binary = await build(backend);
        const [nodeResult, nativeResult] = await Promise.all([
          run(process.execPath, [entry]),
          run(binary, []),
        ]);
        if (!nativeResult.stdout.equals(nodeResult.stdout)) {
          expect(nativeResult.stdout.toString("utf8")).toBe(
            nodeResult.stdout.toString("utf8"),
          );
          expect.unreachable("stdout differed at byte level but not after UTF-8 decoding");
        }
        expect(normalizedStderr(nativeResult)).toBe(
          nodeResult.stderr.toString("utf8"),
        );
        expect(nativeResult.exitCode).toBe(nodeResult.exitCode);
      },
      120_000,
    );
  },
);
