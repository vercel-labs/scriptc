/* The SCRIPTC_CC / SCRIPTC_TARGET driver contract (cc.ts):
 *
 * - The DEFAULT path is pinned: no SCRIPTC_CC (or SCRIPTC_CC=clang) resolves to
 *   ["clang"]. macOS keeps zero extra args; host Linux adds glibc's
 *   -D_GNU_SOURCE compile flag and trailing -lm link library.
 *   SCRIPTC_TARGET without zigcc is an error, not a silently different clang
 *   invocation.
 * - SCRIPTC_CC=zigcc drives `zig cc`. Host-native zigcc builds must produce a
 *   working binary (zig cc is clang underneath); SCRIPTC_TARGET cross builds
 *   must produce an ELF for linux triples and reject the features whose
 *   inputs are host-built (vendored archives, system libs, kqueue units).
 *
 * The native-clang leg runs everywhere (and is selected alone by the
 * ubuntu/glibc CI job). The zig-requiring legs skip when zig is not on
 * PATH — the driver pins above run everywhere.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compileC, compileLibArchive, resolveCc } from "../src/backend/cc.js";

const execFileAsync = promisify(execFile);

function zigOnPath(): boolean {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("default driver keeps bare clang while selecting host platform flags", () => {
  for (const env of [{}, { SCRIPTC_CC: "clang" }, { SCRIPTC_CC: "" }]) {
    const d = resolveCc(env, "darwin");
    expect(d.argv).toEqual(["clang"]);
    expect(d.target).toBeNull();
    expect(d.targetArgs).toEqual([]);
    expect(d.linkArgs).toEqual([]);

    const linux = resolveCc(env, "linux");
    expect(linux.argv).toEqual(["clang"]);
    expect(linux.target).toBeNull();
    expect(linux.targetArgs).toEqual(["-D_GNU_SOURCE"]);
    expect(linux.linkArgs).toEqual(["-lm"]);
  }
});

test("SCRIPTC_TARGET without zigcc is an error, never a silent clang cross build", () => {
  expect(() => resolveCc({ SCRIPTC_TARGET: "aarch64-linux-gnu" })).toThrow(/requires SCRIPTC_CC=zigcc/);
  expect(() => resolveCc({ SCRIPTC_CC: "clang", SCRIPTC_TARGET: "aarch64-linux-gnu" })).toThrow(/requires SCRIPTC_CC=zigcc/);
});

test("unknown SCRIPTC_CC values are rejected", () => {
  expect(() => resolveCc({ SCRIPTC_CC: "gcc" })).toThrow(/unknown SCRIPTC_CC/);
});

test("zigcc resolves to `zig cc`; linux triples add -target and -D_GNU_SOURCE", () => {
  const native = resolveCc({ SCRIPTC_CC: "zigcc" }, "darwin");
  expect(native.argv).toEqual(["zig", "cc"]);
  expect(native.targetArgs).toEqual([]);
  expect(native.linkArgs).toEqual([]);

  const nativeLinux = resolveCc({ SCRIPTC_CC: "zigcc" }, "linux");
  expect(nativeLinux.targetArgs).toEqual(["-D_GNU_SOURCE"]);
  expect(nativeLinux.linkArgs).toEqual(["-lm"]);

  const cross = resolveCc({ SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: "aarch64-linux-gnu.2.36" });
  expect(cross.argv).toEqual(["zig", "cc"]);
  expect(cross.targetArgs).toEqual(["-target", "aarch64-linux-gnu.2.36", "-D_GNU_SOURCE"]);
  expect(cross.linkArgs).toEqual(["-lm"]);

  const musl = resolveCc({ SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: "x86_64-linux-musl" });
  expect(musl.targetArgs).toEqual(["-target", "x86_64-linux-musl", "-D_GNU_SOURCE", "-DSCR_MUSL"]);
  expect(musl.linkArgs).toEqual(["-lm"]);

  // Non-linux triples get the -target but not glibc's visibility macro.
  const mac = resolveCc({ SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: "aarch64-macos" });
  expect(mac.targetArgs).toEqual(["-target", "aarch64-macos"]);
  expect(mac.linkArgs).toEqual([]);

  // Windows triples too: mingw-w64 headers expose everything by default.
  const win = resolveCc({ SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: "x86_64-windows-gnu" });
  expect(win.targetArgs).toEqual(["-target", "x86_64-windows-gnu"]);
  expect(win.linkArgs).toEqual([]);
});

/** Runs body with SCRIPTC_CC/SCRIPTC_TARGET set, restoring the previous values. */
async function withCcEnv(cc: string | undefined, target: string | undefined, body: () => Promise<void>): Promise<void> {
  const prevCc = process.env["SCRIPTC_CC"];
  const prevTarget = process.env["SCRIPTC_TARGET"];
  if (cc === undefined) delete process.env["SCRIPTC_CC"];
  else process.env["SCRIPTC_CC"] = cc;
  if (target === undefined) delete process.env["SCRIPTC_TARGET"];
  else process.env["SCRIPTC_TARGET"] = target;
  try {
    await body();
  } finally {
    if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = prevCc;
    if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = prevTarget;
  }
}

test("cross-target library archives reject host-only ASan", async () => {
  await withCcEnv("zigcc", "x86_64-linux-musl", async () => {
    await expect(
      compileLibArchive({ cPath: "unused.c", outPath: "unused.a", sanitize: true }),
    ).rejects.toThrow(/--sanitize.*not supported under a cross target/s);
  });
});

const HOST_CLANG_C = '#include <stdio.h>\nint main(void) { printf("clang says hi\\n"); return 0; }\n';

test("host-native clang static build compiles the runtime and runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scr-host-clang-"));
  const cPath = join(dir, "program.c");
  await writeFile(cPath, HOST_CLANG_C);
  const outPath = join(dir, "program");
  // This exact default path caught both Linux regressions: without
  // -D_GNU_SOURCE the glibc headers hide declarations used by the runtime;
  // with the macro but no trailing -lm, the runtime's fmod/exp2 references
  // fail to link. macOS keeps exercising its unchanged bare-clang path.
  await withCcEnv(undefined, undefined, () => compileC({ cPath, outPath }));
  const { stdout } = await execFileAsync(outPath);
  expect(stdout).toBe("clang says hi\n");
});

test("host-native clang static build links native fetch after zlib inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scr-host-fetch-clang-"));
  const cPath = join(dir, "program.c");
  await writeFile(
    cPath,
    "void scr_fetch_install(void);\nint main(void) { scr_fetch_install(); return 0; }\n",
  );
  const outPath = join(dir, "program");
  // Ubuntu's GNU ld defaults to left-to-right/as-needed resolution. This
  // link fails when -lz precedes scr_fetch.c even though ld64 accepts it.
  await withCcEnv(undefined, undefined, () =>
    compileC({ cPath, outPath, fetch: true }),
  );
  await execFileAsync(outPath);
}, 600_000);

const HELLO_C = '#include <stdio.h>\nint main(void) { printf("zigcc says hi\\n"); return 0; }\n';
const MUSL_ASYNC_C = `
typedef struct ScrFiber ScrFiber;
typedef struct ScrPromise ScrPromise;
ScrPromise *scr_async_spawn(void (*entry)(ScrFiber *, void *), void *argpack);
void scr_promise_release(ScrPromise *p);
static void entry(ScrFiber *fiber, void *arg) { (void)fiber; (void)arg; }
int main(void) {
  ScrPromise *p = scr_async_spawn(entry, 0);
  scr_promise_release(p);
  return 0;
}
`;

describe.skipIf(!zigOnPath())("zig cc builds (zig on PATH)", () => {
  test("host-native zigcc build compiles the runtime and runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-"));
    const cPath = join(dir, "program.c");
    await writeFile(cPath, HELLO_C);
    const outPath = join(dir, "program");
    await withCcEnv("zigcc", undefined, () => compileC({ cPath, outPath }));
    const { stdout } = await execFileAsync(outPath);
    expect(stdout).toBe("zigcc says hi\n");
  });

  test("cross build for aarch64-linux-gnu produces an ELF", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-cross-"));
    const cPath = join(dir, "program.c");
    await writeFile(cPath, HELLO_C);
    const outPath = join(dir, "program");
    await withCcEnv("zigcc", "aarch64-linux-gnu.2.36", () => compileC({ cPath, outPath }));
    const magic = (await readFile(outPath)).subarray(0, 4);
    expect([...magic]).toEqual([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF
  });

  test("cross build for x86_64-linux-musl provides arc4random_buf and compiles the static runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-musl-"));
    const cPath = join(dir, "program.c");
    await writeFile(cPath, MUSL_ASYNC_C);
    const outPath = join(dir, "program");
    await withCcEnv("zigcc", "x86_64-linux-musl", async () => {
      await compileC({
        cPath,
        outPath,
        events: true,
        net: true,
        http: true,
        http2: true,
        dgram: true,
        watch: true,
        regex: true,
        zlib: true,
        tls: true,
      });
      await expect(compileC({ cPath, outPath, sanitize: true })).rejects.toThrow(
        /--sanitize.*not supported under a cross target/s,
      );
    });
    const magic = (await readFile(outPath)).subarray(0, 4);
    expect([...magic]).toEqual([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF
    await execFileAsync(outPath);
  });

  test("linux cross builds accept fetch natively (no libcurl); the curl reference keeps its soname stub", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-gate-"));
    const cPath = join(dir, "program.c");
    // Reference the fetch unit the way every emitted fetch program does
    // (emitter.ts emits the scr_fetch_install call): an unreferenced unit
    // would let the linker drop the dependency chain and prove nothing.
    await writeFile(cPath, 'void scr_fetch_install(void);\nint main(void) {\n  scr_fetch_install();\n  return 0;\n}\n');
    const outPath = join(dir, "program");
    await withCcEnv("zigcc", "aarch64-linux-gnu.2.36", async () => {
      // The NATIVE fetch rides the socket units (scr_net/scr_http/scr_tls
      // + the vendored zlib objects) — the produced ELF carries NO
      // libcurl dependency at all.
      await compileC({ cPath, outPath, dynamic: true, fetch: true });
      const elf = await readFile(outPath);
      expect([...elf.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF
      expect(elf.includes("libcurl.so.4")).toBe(false);
      // The retired curl REFERENCE (SCRIPTC_FETCH_CURL=1) still links the
      // generated import stub: the binary records DT_NEEDED libcurl.so.4
      // — the string sits verbatim in the ELF's dynamic string table —
      // and binds the target system's real libcurl at load time.
      process.env["SCRIPTC_FETCH_CURL"] = "1";
      try {
        await compileC({ cPath, outPath, dynamic: true, fetch: true });
        const curlElf = await readFile(outPath);
        expect([...curlElf.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
        expect(curlElf.includes("libcurl.so.4")).toBe(true);
      } finally {
        delete process.env["SCRIPTC_FETCH_CURL"];
      }
    });
  }, 600_000);

  test("cross build for x86_64-windows-gnu produces a PE and accepts events/net/http/dgram/tls/watch/zlib/--dynamic/fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-win-"));
    const cPath = join(dir, "program.c");
    await writeFile(cPath, HELLO_C);
    const outPath = join(dir, "program.exe");
    await withCcEnv("zigcc", "x86_64-windows-gnu", async () => {
      await compileC({ cPath, outPath });
      const magic = (await readFile(outPath)).subarray(0, 2);
      expect([...magic]).toEqual([0x4d, 0x5a]); // MZ
      // The units with Windows arms link and produce a PE: events (CRT
      // signal + stdin probes), net/http (winsock + the WSAPoll poller
      // backend), dgram/dns (the winsock datagram arm + ws2tcpip's
      // getaddrinfo), tls (mbedTLS compiled for the triple, -lbcrypt for
      // its entropy poll), watch (ReadDirectoryChangesW), zlib
      // (per-target vendored objects).
      await compileC({ cPath, outPath, events: true, net: true, http: true, dgram: true, watch: true, zlib: true, tls: true });
      const magic2 = (await readFile(outPath)).subarray(0, 2);
      expect([...magic2]).toEqual([0x4d, 0x5a]);
      // --dynamic: the engine archive cross-builds for the windows triple
      // (buildEngineArchiveCross), the island's win32 arms (_msize, the
      // winsock hostname) compile, and the link carries the 8MB PE stack
      // reserve for ISL_MAIN_STACK_BUDGET. The Windows differential lane
      // verifies the @dynamic corpus at runtime against the box's Node.
      await compileC({ cPath, outPath, dynamic: true });
      const magic3 = (await readFile(outPath)).subarray(0, 2);
      expect([...magic3]).toEqual([0x4d, 0x5a]);
      // fetch: NATIVE on win32 too (the socket units' win32 arms + the
      // vendored zlib objects — no libcurl contract needed). The retired
      // curl reference's soname-stub arm stays linux-only.
      await compileC({ cPath, outPath, dynamic: true, fetch: true });
      const magic4 = (await readFile(outPath)).subarray(0, 2);
      expect([...magic4]).toEqual([0x4d, 0x5a]);
      process.env["SCRIPTC_FETCH_CURL"] = "1";
      try {
        await expect(compileC({ cPath, outPath, dynamic: true, fetch: true })).rejects.toThrow(/fetch.*not supported under a cross target/s);
      } finally {
        delete process.env["SCRIPTC_FETCH_CURL"];
      }
    });
  }, 600_000);

  test("regex cross-compiles: the vendored libregexp objects build per target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-lre-"));
    const cPath = join(dir, "program.c");
    await writeFile(cPath, HELLO_C);
    await withCcEnv("zigcc", "x86_64-windows-gnu", async () => {
      await compileC({ cPath, outPath: join(dir, "win.exe"), regex: true });
      const magic = (await readFile(join(dir, "win.exe"))).subarray(0, 2);
      expect([...magic]).toEqual([0x4d, 0x5a]);
    });
    await withCcEnv("zigcc", "aarch64-linux-gnu.2.36", async () => {
      await compileC({ cPath, outPath: join(dir, "linux"), regex: true });
      const magic = (await readFile(join(dir, "linux"))).subarray(0, 4);
      expect([...magic]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    });
  });

  test("cross builds accept the event-loop units, regex, zlib, and tls (per-target poller backends, lre and zlib objects, mbedTLS)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-units-"));
    const cPath = join(dir, "program.c");
    await writeFile(cPath, HELLO_C);
    const outPath = join(dir, "program");
    await withCcEnv("zigcc", "aarch64-linux-gnu.2.36", () =>
      compileC({ cPath, outPath, net: true, http: true, dgram: true, watch: true, events: true, regex: true, zlib: true, tls: true }),
    );
    const magic = (await readFile(outPath)).subarray(0, 4);
    expect([...magic]).toEqual([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF
  });

  test("cross builds accept --dynamic (the engine archive builds per target, no CMake)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-dyn-"));
    const cPath = join(dir, "program.c");
    await writeFile(cPath, HELLO_C);
    const outPath = join(dir, "program");
    await withCcEnv("zigcc", "aarch64-linux-gnu.2.36", () => compileC({ cPath, outPath, dynamic: true }));
    const magic = (await readFile(outPath)).subarray(0, 4);
    expect([...magic]).toEqual([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF
  }, 600_000);
});
