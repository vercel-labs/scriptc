import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { contentDigest, NativeCache } from "./cache.js";
import { identity, NativeExecutableCache } from "./executable-cache.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const directories: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(debug = false) {
  const root = mkdtempSync(join(tmpdir(), "scriptc-native-executable-"));
  directories.push(root);
  const inputs = join(root, "inputs");
  const sdk = join(root, "sdk");
  const stage = join(root, "stage");
  const restored = join(root, "restored");
  for (const directory of [inputs, sdk, stage, restored]) mkdirSync(directory);
  const runtime = join(inputs, "runtime.o");
  const library = join(sdk, "libSystem.tbd");
  writeFileSync(runtime, "runtime");
  writeFileSync(library, "system library");
  // A directory's identity is its stat. Where the file system stamps times
  // at the kernel tick, a file added within the tick of the last write
  // leaves the directory's times unchanged; an old time makes every later
  // change to the SDK directory visible.
  utimesSync(sdk, 0, 0);
  const cache = new NativeCache(join(root, "cache"));
  const key = contentDigest("llvm and options");
  const open = () => new NativeExecutableCache(cache, key, "clang", debug, [runtime]);
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1,
    status: 0,
    signal: null,
    output: [],
    stdout: library + "\n",
    stderr: "",
  });
  const output = join(stage, "program");
  writeFileSync(output, Buffer.from([0, 128, 255, 10]));
  if (debug) {
    const contents = join(output + ".dSYM", "Contents");
    mkdirSync(join(contents, "Resources", "DWARF"), { recursive: true });
    writeFileSync(join(contents, "Info.plist"), "property list");
    writeFileSync(join(contents, "Resources", "DWARF", "program"), "debug information");
  }
  const publish = () => {
    const entry = open();
    expect(entry.trace(["-o", output], stage)).toBe(true);
    entry.publish(output);
  };
  return {
    root,
    inputs,
    sdk,
    stage,
    output,
    destination: join(restored, "program"),
    runtime,
    library,
    cache,
    key,
    open,
    publish,
  };
}

test.each([false, true])(
  "restores a complete executable and its debug information (%s)",
  (debug) => {
    const f = fixture(debug);
    f.publish();
    vi.mocked(spawnSync).mockClear();
    expect(f.open().restore(f.destination)).toBe(true);
    expect(readFileSync(f.destination)).toEqual(readFileSync(f.output));
    if (process.platform !== "win32") expect(statSync(f.destination).mode & 0o111).toBe(0o111);
    expect(spawnSync).not.toHaveBeenCalled();
    if (debug) {
      expect(
        readFileSync(join(f.destination + ".dSYM/Contents/Resources/DWARF/program"), "utf8"),
      ).toBe("debug information");
      expect(readFileSync(join(f.destination + ".dSYM/Contents/Info.plist"), "utf8")).toBe(
        "property list",
      );
    }
  },
);

test.each(["runtime", "library"] as const)(
  "invalidates %s replacement even with restored size and mtime",
  (input) => {
    const f = fixture();
    f.publish();
    const before = statSync(f[input]);
    writeFileSync(f[input] + ".new", "x".repeat(before.size));
    utimesSync(f[input] + ".new", before.atime, before.mtime);
    renameSync(f[input] + ".new", f[input]);
    expect(f.open().restore(f.destination)).toBe(false);
  },
);

test("adding a new SDK library search candidate invalidates the previous link", () => {
  const f = fixture();
  f.publish();
  writeFileSync(join(f.sdk, "libSystem.dylib"), "new candidate");
  expect(f.open().restore(f.destination)).toBe(false);
});

test("a library search change during tracing prevents publication", () => {
  const f = fixture();
  vi.mocked(spawnSync).mockImplementation(() => {
    if (vi.mocked(spawnSync).mock.calls.length === 2)
      writeFileSync(join(f.sdk, "new-library.tbd"), "library");
    return { pid: 1, status: 0, signal: null, output: [], stdout: f.library + "\n", stderr: "" };
  });
  const entry = f.open();
  expect(entry.trace([], f.stage)).toBe(false);
  entry.publish(f.output);
  expect(f.open().restore(f.destination)).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "retargeting an input symlink invalidates the previous link",
  () => {
    const f = fixture();
    const link = join(f.inputs, "current.o");
    symlinkSync(f.runtime, link);
    const open = () => new NativeExecutableCache(f.cache, f.key, "clang", false, [link]);
    const entry = open();
    expect(entry.trace([], f.stage)).toBe(true);
    entry.publish(f.output);
    expect(open().restore(f.destination)).toBe(true);
    const replacement = join(f.inputs, "replacement.o");
    writeFileSync(replacement, "runtime");
    rmSync(link);
    symlinkSync(replacement, link);
    expect(open().restore(f.destination)).toBe(false);
  },
);

test.each(["executable", "binary", "dsym"])("corrupt %s payloads are misses", (family) => {
  const f = fixture(true);
  f.publish();
  const directory = join(f.cache.root, family);
  const key = readdirSync(directory).find((name) => /^[0-9a-f]{64}$/.test(name))!;
  writeFileSync(join(directory, key), "corrupt");
  expect(f.open().restore(f.destination)).toBe(false);
});

test("invalid cache metadata is rejected even with a matching integrity digest", () => {
  const f = fixture();
  f.publish();
  const bytes = f.cache.read("executable", f.key)!;
  const entry = JSON.parse(bytes.toString());
  entry.inputs = [];
  f.cache.write("executable", f.key, JSON.stringify(entry));
  expect(f.open().restore(f.destination)).toBe(false);
});

test("changing an input during emission prevents cache publication", () => {
  const f = fixture();
  const entry = f.open();
  expect(entry.trace([], f.stage)).toBe(true);
  writeFileSync(f.runtime, "replacement runtime");
  entry.publish(f.output);
  expect(f.open().restore(f.destination)).toBe(false);
});

test("metadata cannot omit a required runtime input", () => {
  const f = fixture();
  f.publish();
  const bytes = f.cache.read("executable", f.key)!;
  const entry = JSON.parse(bytes.toString());
  entry.inputs = entry.inputs.filter((input: { path: string }) => input.path !== f.runtime);
  f.cache.write("executable", f.key, JSON.stringify(entry));
  expect(f.open().restore(f.destination)).toBe(false);
});

test("a failed or empty link trace cannot publish a completed executable", () => {
  const f = fixture();
  const entry = f.open();
  entry.publish(f.output);
  expect(f.open().restore(f.destination)).toBe(false);
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1,
    status: 0,
    signal: null,
    output: [],
    stdout: "",
    stderr: "",
  });
  expect(entry.trace([], f.stage)).toBe(false);
  entry.publish(f.output);
  expect(f.open().restore(f.destination)).toBe(false);
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1,
    status: 1,
    signal: null,
    output: [],
    stdout: "",
    stderr: "failed",
  });
  expect(entry.trace([], f.stage)).toBe(false);
});

test.each(["ld", "crt", "libc"] as const)(
  "a Linux key's first link records the linker, startup objects and libc; replacing the %s misses",
  (input) => {
    const f = fixture();
    const lib = join(f.root, "lib");
    mkdirSync(lib);
    const paths = {
      ld: join(f.root, "ld"),
      crt: join(lib, "Scrt1.o"),
      libc: join(lib, "libc.so.6"),
    };
    writeFileSync(paths.ld, "linker");
    writeFileSync(paths.crt, "startup object");
    writeFileSync(paths.libc, "c library");
    const nonshared = join(lib, "libc_nonshared.a");
    writeFileSync(nonshared, "archive");
    const program = join(f.stage, "program.o");
    writeFileSync(program, "program");
    // With -v, clang prints the linker job it runs, as -### would; GNU ld's
    // -t names each file it loads, and an archive member as archive(member).
    const job = ` "${paths.ld}" "-pie" "-o" "${f.output}" "${paths.crt}" "-L${lib}" "${program}" "-lc"`;
    const loaded = [paths.crt, program, paths.libc, `${nonshared}(atexit.oS)`].join("\n");
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      const verbose = (args as string[]).includes("-v");
      return {
        pid: 1,
        status: 0,
        signal: null,
        output: [],
        stdout: verbose ? loaded + "\n" : "",
        stderr: verbose ? job + "\n" : "",
      };
    });
    const open = () => new NativeExecutableCache(f.cache, f.key, "clang", false, [f.runtime], true);
    // A key's first link traces the driver and the linker in one run, and
    // records the output it leaves instead of storing the executable.
    const entry = open();
    expect(entry.trace(["-o", f.output], f.stage)).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnSync).mock.calls[0]![1]).toEqual(["-o", f.output, "-v", "-Wl,-t"]);
    entry.publish(f.output);
    expect(f.cache.read("executable", f.key)).toBeNull();
    entry.recordOutput(f.output);
    expect(open().keep(f.output)).toBe(true);
    const recorded = (
      JSON.parse(f.cache.read("kept", f.key)!.toString()) as { inputs: { path: string }[] }
    ).inputs.map((saved) => saved.path);
    expect(recorded).toEqual(expect.arrayContaining([...Object.values(paths), nonshared, lib]));
    expect(recorded).not.toContain(program);
    const before = statSync(paths[input]);
    writeFileSync(paths[input] + ".new", "x".repeat(before.size));
    utimesSync(paths[input] + ".new", before.atime, before.mtime);
    renameSync(paths[input] + ".new", paths[input]);
    expect(open().keep(f.output)).toBe(false);
  },
);

test("a Linux build whose output changed links again, and then stores the executable", () => {
  const f = fixture();
  const open = () => new NativeExecutableCache(f.cache, f.key, "clang", false, [f.runtime], true);
  const first = open();
  expect(first.trace(["-o", f.output], f.stage)).toBe(true);
  first.publish(f.output);
  first.recordOutput(f.output);
  // The output is overwritten: it is not kept, and the next link publishes.
  writeFileSync(f.output, Buffer.from([1, 2, 3, 4]));
  expect(open().keep(f.output)).toBe(false);
  const second = open();
  expect(second.restore(f.destination)).toBe(false);
  expect(second.trace(["-o", f.output], f.stage)).toBe(true);
  second.publish(f.output);
  second.recordOutput(f.output);
  expect(open().keep(f.output)).toBe(true);
  // The stored executable restores at another path.
  expect(open().restore(f.destination)).toBe(true);
  expect(readFileSync(f.destination)).toEqual(readFileSync(f.output));
});

test("a Linux build that keeps its output does not read the deferred inputs", () => {
  const f = fixture();
  const artifact = join(f.root, "inputs", "artifact.o");
  writeFileSync(artifact, "runtime pack artifact");
  const deferred = vi.fn(() => [artifact]);
  const open = () =>
    new NativeExecutableCache(f.cache, f.key, "clang", false, [f.runtime], true, deferred);
  const first = open();
  expect(first.trace(["-o", f.output], f.stage)).toBe(true);
  first.recordOutput(f.output);
  expect(deferred).toHaveBeenCalledTimes(1);
  const recorded = (
    JSON.parse(f.cache.read("kept", f.key)!.toString()) as { inputs: { path: string }[] }
  ).inputs.map((saved) => saved.path);
  expect(recorded).toContain(artifact);
  // The unchanged rebuild checks the recorded identities, the artifact's
  // among them, without asking for the deferred inputs.
  expect(open().keep(f.output)).toBe(true);
  expect(deferred).toHaveBeenCalledTimes(1);
  // A replaced artifact misses.
  writeFileSync(artifact, "another runtime pack artifact");
  expect(open().keep(f.output)).toBe(false);
  expect(deferred).toHaveBeenCalledTimes(1);
  // restore() adds the deferred inputs before it checks an entry.
  const second = open();
  expect(second.trace(["-o", f.output], f.stage)).toBe(true);
  second.publish(f.output);
  expect(open().restore(f.destination)).toBe(true);
  expect(deferred).toHaveBeenCalledTimes(3);
});

test("a Linux link that runs as its linker job is traced from the job's run, and otherwise records it", () => {
  const f = fixture();
  const lib = join(f.root, "lib");
  mkdirSync(lib);
  const crt = join(lib, "Scrt1.o");
  writeFileSync(crt, "startup object");
  const program = join(f.stage, "program.o");
  writeFileSync(program, "program");
  const job = {
    run: vi.fn((_args: string[], _list: boolean) => ({
      output: [crt, program].join("\n") + "\n",
      driverInputs: [identity(crt), identity(lib)],
    })),
    record: vi.fn(),
  };
  const open = () => new NativeExecutableCache(f.cache, f.key, "clang", false, [f.runtime], true);
  const entry = open();
  expect(entry.trace(["-o", f.output], f.stage, job)).toBe(true);
  // The job runs the traced link, and the driver does not.
  expect(job.run.mock.calls[0]).toEqual([["-o", f.output, "-v", "-Wl,-t"], false]);
  expect(spawnSync).not.toHaveBeenCalled();
  expect(job.record).not.toHaveBeenCalled();
  entry.recordOutput(f.output);
  const recorded = (
    JSON.parse(f.cache.read("kept", f.key)!.toString()) as { inputs: { path: string }[] }
  ).inputs.map((saved) => saved.path);
  expect(recorded).toEqual(expect.arrayContaining([crt, lib]));
  expect(recorded).not.toContain(program);
  expect(open().keep(f.output)).toBe(true);
  // A link without a job runs through the driver, and records the job from
  // the driver's output.
  const record = vi.fn();
  expect(open().trace(["-o", f.output], f.stage, { run: () => null, record })).toBe(true);
  expect(spawnSync).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledWith(["-o", f.output, "-v", "-Wl,-t"], f.library + "\n\n", [
    identity(f.sdk),
    identity(f.library),
  ]);
});
