import { InternalCompilerError } from "../../errors.js";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { localizeElfObject, mergeAndLocalizeCoffObjects } from "../object-localize.js";
import { type CcDriver, targetPlatform } from "./driver.js";
import { execFileAsync, subprocessFailureDetail } from "./process.js";

/* Demotes in process (localizeElfObject), rewriting the object in place. */
async function localizeInProcess(object: string, keepSymbols: readonly string[]): Promise<void> {
  try {
    await writeFile(object, localizeElfObject(await readFile(object), new Set(keepSymbols)));
  } catch (err) {
    throw new Error(
      `ELF symbol localization failed while localizing the library archive's runtime symbols (abi.localize_runtime).\n\n${(err as Error).message}`,
    );
  }
}

/* Multi-instance library mode's localization step: combine the program
 * object with exactly the runtime/vendor members it reaches into ONE
 * relocatable object, then demote every scriptc external definition except
 * the profile-declared symbols to a local symbol. The internals are not
 * renamed apart — they stop being visible to the embedder's linker at all,
 * so a second archive built under a different prefix brings its own private
 * copy of the whole runtime (allocator, collector, arena, panic sink) into
 * the same process. Undefined references (the target C/math runtime and
 * system APIs, plus sanitizer ABI in instrumented builds) keep their global
 * binding: those platform services and the sanitizer are the embedder's,
 * shared by design. Windows embedders additionally link advapi32, iphlpapi,
 * and ws2_32.
 *
 * The generated program and optional identity objects are mandatory roots;
 * support-member selection still matters. A classic archive's unused members (and their
 * undefined references to units library mode excludes, like the
 * fs-promises unit's fiber symbols) never reach an embedder's link. A
 * blind merge of every object would carry those references into the one
 * combined member. Staging the support objects into an intermediate
 * archive keeps the linker's own member semantics: `ld -r` pulls only the
 * members the program object transitively needs (the COFF arm implements
 * the same member semantics in process).
 *
 *   Mach-O — one host-ld64 invocation: -r merges roots + needed members,
 *            -exported_symbols_list demotes every unlisted global to
 *            private extern, and -r without -keep_private_externs writes
 *            private externs out as non-external symbols. Apple ASan's
 *            image-registration COMMON remains shared so the final Mach-O
 *            image registers its globals once. ld64 reads every Apple
 *            platform's objects — macOS architectures and the iOS/
 *            iOS-simulator triples alike (LC_BUILD_VERSION platform and
 *            minos survive the merge) — so darwin-host macos AND ios
 *            targets ride the same arm; compileLibrary refuses those
 *            targets elsewhere.
 *   ELF, native linux host — ld -r merges with --force-group-allocation
 *            (ASan's instrumented globals ride ELF section groups whose
 *            signatures repeat across archives sharing runtime objects;
 *            resolving the groups into the combined member keeps a later
 *            multi-archive link from discarding one archive's copies),
 *            then binutils objcopy --keep-global-symbols localizes every
 *            other DEFINED global (objcopy leaves undefined symbols
 *            global by its own rule). The exact historical recipe. With
 *            `inProcessElf` (program-shard merges), localizeElfObject
 *            demotes instead of objcopy: a sanitized dev program merges
 *            into an object with hundreds of thousands of sections, which
 *            objcopy takes minutes over and localizeElfObject seconds.
 *   ELF, cross triples from any host — `zig cc -target <triple> -r`
 *            merges (zig is already the cross driver's hard requirement),
 *            then localizeElfObject demotes in process and resolves
 *            section groups the way --force-group-allocation does, with
 *            no host binutils/llvm-objcopy dependency.
 *   COFF, native win32 hosts and windows cross triples from any host —
 *            mergeAndLocalizeCoffObjects performs member selection, the
 *            merge, cross-object symbol resolution, and demotion in
 *            process: no linker offers a COFF relocatable mode (lld-link
 *            mirrors MSVC link.exe; zig's COFF driver refuses multi-object
 *            merges) and llvm-objcopy rejects symbol-scope flags for
 *            COFF, so no tool pairing exists to shell out to. */
export async function localizeLibraryObjects(
  driver: CcDriver,
  arArgv: readonly string[],
  buildDir: string,
  rootObjects: readonly string[],
  supportObjects: readonly string[],
  keepSymbols: readonly string[],
  stem: string,
  platform = targetPlatform(driver),
  options: { inProcessElf?: boolean } = {},
): Promise<string> {
  const combined = join(buildDir, `${stem}.localized.o`);
  const staging = join(buildDir, `${stem}.localize-staging.a`);
  const keepFile = join(buildDir, "localize-keep.syms");
  const run = async (argv: readonly string[]): Promise<void> => {
    try {
      await execFileAsync(argv[0]!, [...argv.slice(1)]);
    } catch (err) {
      const stderr = subprocessFailureDetail(err);
      throw new Error(
        `${argv[0]} failed while localizing the library archive's runtime symbols (abi.localize_runtime).\n` +
          `Runtime symbol localization needs the ${platform === "darwin" || (driver.target === null && options.inProcessElf === true) ? "host toolchain's ld" : driver.target === null ? "host toolchain's ld and objcopy" : "cross driver's relocatable link"} beside the C compiler.\n\n${stderr}`,
      );
    }
  };
  if (platform === "win32") {
    // COFF has no relocatable-link tool to stage through; the member
    // selection and combine+demote happen in process over the object bytes.
    const [roots, support] = await Promise.all([
      Promise.all(rootObjects.map((path) => readFile(path))),
      Promise.all(supportObjects.map((path) => readFile(path))),
    ]);
    try {
      await writeFile(
        combined,
        mergeAndLocalizeCoffObjects(roots, support, new Set(keepSymbols), {
          roots: rootObjects.map((path) => basename(path)),
          support: supportObjects.map((path) => basename(path)),
        }),
      );
    } catch (err) {
      throw new Error(
        `COFF symbol localization failed while localizing the library archive's runtime symbols (abi.localize_runtime).\n\n${(err as Error).message}`,
      );
    }
    return combined;
  }
  const supportArgs = supportObjects.length === 0 ? [] : [staging];
  if (supportObjects.length > 0) {
    await run([arArgv[0] ?? "ar", ...arArgv.slice(1), "rcs", staging, ...supportObjects]);
  }
  if (platform === "darwin") {
    await writeFile(keepFile, keepSymbols.map((s) => `_${s}\n`).join(""));
    await run([
      "ld",
      "-r",
      ...rootObjects,
      ...supportArgs,
      "-o",
      combined,
      "-exported_symbols_list",
      keepFile,
    ]);
  } else if (platform === "linux" && driver.target === null) {
    await run([
      "ld",
      "-r",
      "--force-group-allocation",
      ...rootObjects,
      ...supportArgs,
      "-o",
      combined,
    ]);
    if (options.inProcessElf === true) {
      await localizeInProcess(combined, keepSymbols);
    } else {
      await writeFile(keepFile, keepSymbols.map((s) => `${s}\n`).join(""));
      await run(["objcopy", `--keep-global-symbols=${keepFile}`, combined]);
    }
  } else if (platform === "linux") {
    // Cross ELF: the cross driver's own lld performs the relocatable merge
    // (with the staging archive's member semantics); demotion and section-
    // group resolution happen in process. -nostdlib keeps zig from feeding
    // libc/compiler-rt inputs into the merge. Android rides this arm
    // unchanged: bionic archives are ordinary aarch64 ELF64, and the merge
    // uses the driver's zig spelling (which pins the API floor).
    await run([
      driver.argv[0] ?? "zig",
      ...driver.argv.slice(1),
      "-target",
      driver.zigTarget ?? driver.target!,
      "-nostdlib",
      "-r",
      ...rootObjects,
      ...supportArgs,
      "-o",
      combined,
    ]);
    await localizeInProcess(combined, keepSymbols);
  } else {
    throw new InternalCompilerError(
      `runtime symbol localization (abi.localize_runtime) has no ${platform} arm; compileLibrary admits darwin, linux, and win32 builds only`,
    );
  }
  return combined;
}
