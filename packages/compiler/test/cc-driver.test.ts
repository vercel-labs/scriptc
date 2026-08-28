/* The SCRIPTC_CC / SCRIPTC_TARGET driver contract (native-toolchain.ts):
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
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { EOL, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  compileC,
  configuredTargetPlatform,
  resolveCc,
  runtimeSrcDir,
  subprocessFailureDetail,
} from "../src/backend/native-toolchain.js";

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
  expect(() => resolveCc({ SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: "wasm64-wasi" })).toThrow(/supported: wasm32-wasi/);
});

test("pure target classification validates spellings without compiler discovery", () => {
  expect(configuredTargetPlatform({ SCRIPTC_TARGET: "wasm32-wasi", SCRIPTC_CC: "missing" })).toBe("wasi");
  expect(configuredTargetPlatform({ SCRIPTC_TARGET: "aarch64-linux-gnu.2.36", SCRIPTC_CC: "missing" })).toBe("linux");
  expect(() => configuredTargetPlatform({ SCRIPTC_TARGET: "wasm64-wasi", SCRIPTC_CC: "missing" }))
    .toThrow(/supported: wasm32-wasi/);
  expect(() => configuredTargetPlatform({ SCRIPTC_TARGET: "totally-invalid", SCRIPTC_CC: "missing" }))
    .toThrow(/unsupported target/);
});

test("subprocess failures retain diagnostics when stderr is empty", () => {
  expect(subprocessFailureDetail({
    stderr: "",
    stdout: "zig: actual failure\n",
  })).toBe("compiler stdout:\nzig: actual failure");

  const noOutput = Object.assign(new Error("zig cc exited with code 1"), {
    stderr: "",
    stdout: "",
  });
  expect(subprocessFailureDetail(noOutput)).toBe("zig cc exited with code 1");
});

test("an empty ANDROID_NDK_ROOT does not mask ANDROID_NDK_HOME", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scr-android-ndk-home-"));
  const home = join(dir, "ndk-home");
  const sysroot = join(home, "toolchains", "llvm", "prebuilt", "test-host", "sysroot");
  await mkdir(join(sysroot, "usr", "include", "aarch64-linux-android"), { recursive: true });

  const driver = resolveCc({
    SCRIPTC_CC: "zigcc",
    SCRIPTC_TARGET: "aarch64-linux-android",
    ANDROID_NDK_ROOT: "",
    ANDROID_NDK_HOME: home,
  });
  expect(driver.targetArgs).toContain(join(sysroot, "usr", "include"));
});

test.skipIf(process.platform === "win32")("iOS SDK discovery uses the resolver's explicit environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scr-ios-sdk-env-"));
  const bin = join(dir, "bin");
  const sdk = join(dir, "Custom.sdk");
  await mkdir(bin);
  await mkdir(join(sdk, "usr", "include"), { recursive: true });
  const xcrun = join(bin, "xcrun");
  await writeFile(xcrun, '#!/bin/sh\nprintf "%s\\n" "$SCRIPTC_TEST_SDK_PATH"\n');
  await chmod(xcrun, 0o755);

  const driver = resolveCc({
    PATH: bin,
    SCRIPTC_CC: "zigcc",
    SCRIPTC_TARGET: "aarch64-apple-ios",
    DEVELOPER_DIR: join(dir, "CustomXcode.app", "Contents", "Developer"),
    SCRIPTC_TEST_SDK_PATH: sdk,
  }, "darwin");
  expect(driver.targetArgs).toContain(sdk);
});

test("zigcc resolves to `zig cc`; linux triples add their libc target flags", () => {
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
  expect(musl.targetArgs).toEqual([
    "-target",
    "x86_64-linux-musl",
    "-D_GNU_SOURCE",
    "-DSCR_MUSL",
  ]);
  expect(musl.linkArgs).toEqual(["-lm"]);

  const armMusl = resolveCc({ SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: "aarch64-linux-musl" });
  expect(armMusl.targetArgs).toEqual([
    "-target",
    "aarch64-linux-musl",
    "-D_GNU_SOURCE",
    "-DSCR_MUSL",
  ]);
  expect(armMusl.linkArgs).toEqual(["-lm"]);

  // Non-linux triples get the -target but not glibc's visibility macro.
  const mac = resolveCc({ SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: "aarch64-macos" });
  expect(mac.targetArgs).toEqual(["-target", "aarch64-macos"]);
  expect(mac.linkArgs).toEqual([]);

  // Windows triples too: mingw-w64 headers expose everything by default.
  const win = resolveCc({ SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: "x86_64-windows-gnu" });
  expect(win.targetArgs).toEqual(["-target", "x86_64-windows-gnu"]);
  expect(win.linkArgs).toEqual([]);

  // WASI uses wasi-libc's explicit emulation archives for the small signal
  // and process-clock surface retained by the portable runtime.
  const wasi = resolveCc({ SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: "wasm32-wasi" });
  expect(wasi.targetArgs).toEqual([
    "-target", "wasm32-wasi", "-D_GNU_SOURCE",
    "-D_WASI_EMULATED_SIGNAL", "-D_WASI_EMULATED_PROCESS_CLOCKS",
  ]);
  expect(wasi.linkArgs).toEqual([
    "-lwasi-emulated-signal", "-lwasi-emulated-process-clocks",
  ]);
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
const MUSL_RUNTIME_C = `
#include <stddef.h>
#include <ucontext.h>
void arc4random_buf(void *, size_t);
int main(void) {
  ucontext_t here;
  unsigned char random_byte;
  arc4random_buf(&random_byte, sizeof random_byte);
  return getcontext(&here);
}
`;
const WINDOWS_CA_EKU_C = String.raw`
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <windows.h>
#include <wincrypt.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  FILE *file = fopen(argv[1], "rb");
  if (file == NULL) return 3;
  if (fseek(file, 0, SEEK_END) != 0) return 4;
  long pem_len = ftell(file);
  if (pem_len <= 0 || pem_len > UINT32_MAX) return 5;
  rewind(file);
  char *pem = malloc((size_t)pem_len + 1);
  if (pem == NULL) return 6;
  size_t got = fread(pem, 1, (size_t)pem_len, file);
  fclose(file);
  pem[got] = 0;

  DWORD der_len = 0;
  if (!CryptStringToBinaryA(pem, (DWORD)got, CRYPT_STRING_BASE64HEADER,
                            NULL, &der_len, NULL, NULL)) return 7;
  BYTE *der = malloc((size_t)der_len);
  if (der == NULL) return 8;
  if (!CryptStringToBinaryA(pem, (DWORD)got, CRYPT_STRING_BASE64HEADER,
                            der, &der_len, NULL, NULL)) return 9;
  free(pem);
  PCCERT_CONTEXT cert = CertCreateCertificateContext(
      X509_ASN_ENCODING, der, der_len);
  free(der);
  if (cert == NULL) return 10;

  LPSTR code_signing = szOID_PKIX_KP_CODE_SIGNING;
  CERT_ENHKEY_USAGE usage = {1, &code_signing};
  if (!CertSetEnhancedKeyUsage(cert, &usage)) return 11;
  if (scr_tls_ca_windows_cert_server_auth(cert)) return 12;

  LPSTR server_auth = szOID_PKIX_KP_SERVER_AUTH;
  usage.rgpszUsageIdentifier = &server_auth;
  if (!CertSetEnhancedKeyUsage(cert, &usage)) return 13;
  if (!scr_tls_ca_windows_cert_server_auth(cert)) return 14;

  LPSTR any_usage = szOID_ANY_ENHANCED_KEY_USAGE;
  usage.rgpszUsageIdentifier = &any_usage;
  if (!CertSetEnhancedKeyUsage(cert, &usage)) return 15;
  if (!scr_tls_ca_windows_cert_server_auth(cert)) return 16;

  usage.cUsageIdentifier = 0;
  usage.rgpszUsageIdentifier = NULL;
  if (!CertSetEnhancedKeyUsage(cert, &usage)) return 17;
  if (scr_tls_ca_windows_cert_server_auth(cert)) return 18;

  CertFreeCertificateContext(cert);
  fputs("windows EKU policy ok\n", stdout);
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

  test("cross build for x86_64-linux-musl links the libc and ucontext shims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-musl-"));
    const cPath = join(dir, "program.c");
    await writeFile(cPath, MUSL_RUNTIME_C);
    const outPath = join(dir, "program");
    await withCcEnv("zigcc", "x86_64-linux-musl", () => compileC({ cPath, outPath }));
    const elf = await readFile(outPath);
    expect([...elf.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
  });

  test("cross build for aarch64-linux-musl links the libc and ucontext shims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-aarch64-musl-"));
    const cPath = join(dir, "program.c");
    await writeFile(cPath, MUSL_RUNTIME_C);
    const outPath = join(dir, "program");
    await withCcEnv("zigcc", "aarch64-linux-musl", () => compileC({ cPath, outPath }));
    const elf = await readFile(outPath);
    expect([...elf.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    expect(elf.readUInt16LE(18)).toBe(183); // EM_AARCH64
  });

  test("musl library CSPRNG failures stay on the library trap funnel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-musl-lib-"));
    const object = join(dir, "scr_musl.o");
    const rtDir = runtimeSrcDir();
    await execFileAsync("zig", [
      "cc",
      "-target", "x86_64-linux-musl",
      "-std=c11",
      "-D_GNU_SOURCE",
      "-DSCR_MUSL",
      "-DSCR_LIB",
      "-I", rtDir,
      "-c", join(rtDir, "scr_musl.c"),
      "-o", object,
    ]);
    const undefinedSymbols = execFileSync("nm", ["-u", object], { encoding: "utf8" });
    expect(undefinedSymbols).toMatch(/\b_?scr_trap\b/);
    expect(undefinedSymbols).not.toMatch(/\b_?(?:fputs|abort)\b/);
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
    const caProbePath = join(dir, "ca-eku.c");
    await writeFile(cPath, HELLO_C);
    await writeFile(caProbePath, WINDOWS_CA_EKU_C);
    const outPath = join(dir, "program.exe");
    const caOutPath = join(dir, "ca-probe.exe");
    await withCcEnv("zigcc", "x86_64-windows-gnu", async () => {
      await compileC({ cPath, outPath });
      const magic = (await readFile(outPath)).subarray(0, 2);
      expect([...magic]).toEqual([0x4d, 0x5a]); // MZ
      // CA introspection is mbedTLS-free but imports and PEM-encodes the
      // same filtered Windows certificate-store entries that the TLS client
      // consumes.
      await compileC({ cPath: caProbePath, outPath: caOutPath, tlsCa: true });
      const caPe = await readFile(caOutPath);
      expect(caPe.includes("CRYPT32.dll")).toBe(true);
      expect(caPe.includes("bcrypt.dll")).toBe(false);
      expect(caPe.includes("TrustedPeople")).toBe(true);
      // The units with Windows arms link and produce a PE: events (CRT
      // signal + stdin probes), net/http (winsock + the WSAPoll poller
      // backend), dgram/dns (the winsock datagram arm + ws2tcpip's
      // getaddrinfo), tls (mbedTLS compiled for the triple, -lbcrypt for
      // its entropy poll and -lcrypt32 for the ROOT certificate store),
      // watch (ReadDirectoryChangesW), zlib
      // (per-target vendored objects).
      await compileC({ cPath, outPath, events: true, net: true, http: true, dgram: true, watch: true, zlib: true, tls: true });
      const tlsPe = await readFile(outPath);
      const magic2 = tlsPe.subarray(0, 2);
      expect([...magic2]).toEqual([0x4d, 0x5a]);
      expect(tlsPe.includes("CRYPT32.dll")).toBe(true);
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

  test.skipIf(process.platform !== "win32")(
    "Windows CA roots honor the effective server-auth EKU property",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scr-zigcc-win-ca-eku-"));
      const cPath = join(dir, "program.c");
      const outPath = join(dir, "program.exe");
      await writeFile(cPath, WINDOWS_CA_EKU_C);
      await withCcEnv("zigcc", "x86_64-windows-gnu", () =>
        compileC({ cPath, outPath, tlsCa: true }),
      );
      const caPath = join(
        import.meta.dirname,
        "../../../tests/fixtures/server/certs/ca.pem",
      );
      const { stdout } = await execFileAsync(outPath, [caPath]);
      expect(stdout).toBe(`windows EKU policy ok${EOL}`);
    },
    600_000,
  );

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
