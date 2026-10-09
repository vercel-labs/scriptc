import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { compile, compileLibrary } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(source: string) {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-worker-target-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  return { entry, outDir, outPath: join(outDir, "program.ll"), outputKind: "llvm" as const };
}
const worker =
  'import { Worker } from "node:worker_threads"; new Worker(new URL(import.meta.url));';

test.each(["dynamic", "wasi"])(
  "worker constructors refuse %s execution before code generation",
  async (mode) => {
    const request = await fixture(worker);
    if (mode === "wasi") {
      vi.stubEnv("SCRIPTC_CC", "zigcc");
      vi.stubEnv("SCRIPTC_TARGET", "wasm32-wasi");
    }
    const result = await compile(request.entry, { ...request, dynamic: mode === "dynamic" });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "SC2020",
            message: expect.stringContaining("Worker execution"),
          }),
        ]),
      );
  },
);

test("runtime worker filenames produce an actionable source diagnostic", async () => {
  const request = await fixture(
    'import { Worker } from "node:worker_threads"; new Worker(process.argv[2]);',
  );
  const result = await compile(request.entry, request);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SC2020",
          hint: expect.stringContaining("statically compiled"),
        }),
      ]),
    );
});

test("libraries refuse worker roots through the library diagnostic boundary", async () => {
  const request = await fixture(worker + "\nexport function boot(): number { return 0; }");
  const profilePath = join(request.outDir, "profile.json");
  await writeFile(
    profilePath,
    JSON.stringify({
      profile_format: 1,
      name: "worker-library",
      entry: "main.ts",
      emission: "llvm",
      abi: {
        prefix: "w_",
        init_symbol: "w_init",
        sink_register_symbol: "w_panic",
        collect_symbol: null,
        result_reset_symbol: null,
      },
      exports: [{ export: "boot", symbol: "w_boot", params: [], returns: "f64" }],
    }),
  );
  const result = await compileLibrary({ profilePath, outDir: request.outDir });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SC4005", message: expect.stringContaining("worker") }),
      ]),
    );
});

test("worker TLS arguments use local snapshots before native pointer expansion", async () => {
  const request = await fixture(
    worker +
      '\nimport { createSecureContext } from "node:tls"; const cert = Buffer.from(new SharedArrayBuffer(4)); createSecureContext({cert, key: cert});',
  );
  const result = await compile(request.entry, request);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) {
    const llvm = await readFile(request.outPath, "utf8");
    expect(llvm).toContain("call ptr @scr_bytes_local_copy(");
    expect(llvm).toContain("call ptr @scr_tls_create_secure_context(");
  }
});

test("worker programs refuse foreign callbacks and guard byte-pointer FFI calls", async () => {
  for (const foreign of [true, false]) {
    const source = foreign
      ? "declare function nativeStart(cb: (value: number) => void): void; nativeStart(() => {});"
      : "declare function consume(value: Uint8Array): number; consume(new Uint8Array(new SharedArrayBuffer(4)));";
    const request = await fixture(worker + source);
    const ffiProfilePath = join(request.outDir, "ffi.json");
    await writeFile(
      ffiProfilePath,
      JSON.stringify({
        ffi_format: 5,
        functions: [
          foreign
            ? {
                name: "nativeStart",
                symbol: "native_start",
                returns: "void",
                params: [
                  {
                    callback: {
                      id: "tick",
                      params: ["f64", { context: "tick" }],
                      returns: "void",
                      lifetime: "retained",
                      invoke: "foreign",
                    },
                  },
                  { context: "tick" },
                ],
              }
            : { name: "consume", symbol: "consume", params: ["bytes"], returns: "f64" },
        ],
      }),
    );
    const result = await compile(request.entry, { ...request, ffiProfilePath });
    expect(result.ok, JSON.stringify(result)).toBe(!foreign);
    if (result.ok)
      expect(await readFile(request.outPath, "utf8")).toContain(
        "call void @scr_bytes_require_unshared(",
      );
    else
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "SC2020",
            message: expect.stringContaining("foreign-thread"),
          }),
        ]),
      );
  }
});

test("worker programs keep thread-local allocator and async state behind runtime calls", async () => {
  const source =
    worker +
    `
class Cell {
  constructor(public next: Cell | null, public value: number) {}
}
let head: Cell | null = null;
for (let i = 0; i < 3; i++) head = new Cell(head, i);
async function settle(): Promise<number> {
  return head === null ? 0 : head.value;
}
settle().then((value) => console.log(value));
`;
  const request = await fixture(source);
  const result = await compile(request.entry, request);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) {
    const llvm = await readFile(request.outPath, "utf8");
    // scr_cyc_live and scr_weak_dispose_hook are thread-local in worker
    // runtimes, and their small-object allocator is compiled out.
    expect(llvm).not.toContain("@scr_sa");
    expect(llvm).not.toContain("@scr_cyc_live");
    expect(llvm).not.toContain("@scr_weak_dispose_hook");
    // Worker fibers own context termination; no fiberless async frames.
    expect(llvm).not.toContain("@scr_async_inline_enter");
  }
});

test("JavaScript worker entry spellings run their TypeScript sources", async () => {
  const request = await fixture(`import { Worker } from "node:worker_threads";
function run(worker: Worker): Promise<void> {
  return new Promise<void>((resolve) => {
    worker.on("message", (text: string) => console.log(text));
    worker.on("exit", () => resolve());
  });
}
await run(new Worker(new URL("./task.js", import.meta.url)));
await run(new Worker(new URL("./module-task.mjs", import.meta.url)));
`);
  for (const [file, text] of [
    ["task.ts", "script task"],
    ["module-task.mts", "module task"],
  ])
    await writeFile(
      join(request.outDir, file),
      `import { parentPort } from "node:worker_threads";\nparentPort!.postMessage("${text}");\n`,
    );
  const outPath = join(request.outDir, "program");
  const result = await compile(request.entry, { outDir: request.outDir, outPath });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const { stdout } = await promisify(execFile)(outPath, [], { encoding: "utf8" });
  expect(stdout).toBe("script task\nmodule task\n");
});

test("worker entries without a source file stay refused", async () => {
  const request = await fixture(
    'import { Worker } from "node:worker_threads"; new Worker(new URL("./missing.js", import.meta.url));',
  );
  const result = await compile(request.entry, request);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("missing.js") }),
      ]),
    );
});

test("worker programs poll inline and skip termination polls in bounded functions", async () => {
  const request = await fixture(
    worker +
      `
function mix(a: number, b: number): number { return (a * 31 + b) % 1000003; }
function spin(n: number): number { return n < 2 ? mix(n, 1) : spin(n - 1) + spin(n - 2); }
console.log(mix(1, 2), spin(5));
`,
  );
  const result = await compile(request.entry, request);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) {
    const llvm = await readFile(request.outPath, "utf8");
    const body = (name: string): string => {
      const start = llvm.search(new RegExp(`^define [^\\n]*@${name}\\(`, "m"));
      expect(start).toBeGreaterThanOrEqual(0);
      return llvm.slice(start, llvm.indexOf("\n}\n", start));
    };
    // A bounded helper neither polls on entry nor makes its callers poll.
    expect(body("sc_f_mix")).not.toContain("@scr_exc_active");
    // Recursion polls on entry: the stop signal folds into the inline test,
    // and only the slow path calls into the runtime.
    expect(body("sc_f_spin")).toContain("load ptr, ptr @scr_exc_active");
    expect(body("sc_f_spin")).toContain("load ptr, ptr @scr_context_signal");
    expect(body("sc_f_spin")).toMatch(/load atomic i8, ptr %t\d+ monotonic/);
    expect(llvm).toContain("@scr_exc_active = external thread_local global ptr");
  }
});
