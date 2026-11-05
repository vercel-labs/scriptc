import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Copy release payloads explicitly; development caches and build trees never ship. */
export function copyPackage(source, destination, members) {
  mkdirSync(destination, { recursive: true });
  for (const member of ["package.json", ...members]) {
    cpSync(join(source, member), join(destination, member), {
      recursive: true,
      filter: (path) => ![".cache", "node_modules", ".DS_Store"].includes(basename(path)),
    });
  }
  for (const name of readdirSync(source)) {
    if (/^(?:LICENSE|COPYING|NOTICE|SCRIPTC_LICENSE|THIRD_PARTY_NOTICES)(?:\..*)?$/.test(name)) {
      cpSync(join(source, name), join(destination, name));
    }
  }
}

/** The LLVM helper and host runtime pack packages a native CLI package
 * depends on. */
export function platformPackagesOf(identity) {
  const names = Object.keys(identity.dependencies ?? {});
  const helper = names.find((name) => name.startsWith("@scriptc/llvm-"));
  const runtime = names.find((name) => name.startsWith("@scriptc/runtime-"));
  if (helper === undefined || runtime === undefined)
    throw new Error(`${identity.name} must depend on its LLVM helper and runtime pack packages`);
  return { helper, runtime };
}

/** Copies the helper and runtime pack packages from `packages` (the
 * workspace's packages directory) into a distribution's lib directory, as a
 * standalone archive needs them, and returns the manifest paths, relative to
 * the distribution's bin directory in the target's path style. */
export function bundlePlatformPackages({ packages, distribution, helper, runtime, windows }) {
  const short = (name) => name.replace("@scriptc/", "");
  copyPackage(join(packages, short(helper)), join(distribution, "lib", "llvm"), ["bin"]);
  copyPackage(join(packages, short(runtime)), join(distribution, "lib", short(runtime)), [
    "artifacts",
    "runtime-pack.json",
  ]);
  const path = (name) => ["..", "lib", name].join(windows ? "\\" : "/");
  return { llvm_package: path("llvm"), runtime_pack: path(short(runtime)) };
}

/** The THIRD_PARTY_NOTICES line for the LLVM helper, bundled or as a dependency. */
export function llvmNotice(helper) {
  return helper === undefined
    ? "LLVM licensing and notices: lib/llvm/LICENSE and lib/llvm/THIRD_PARTY_NOTICES."
    : `LLVM licensing and notices: LICENSE and THIRD_PARTY_NOTICES in the ${helper} package.`;
}

/** Turns a distribution that bundles its LLVM helper and runtime pack into
 * an npm platform package's: removes both from lib and from the manifest at
 * `manifestPath`, as `build-native-cli.mts --platform-packages` builds it. */
export function unbundlePlatformPackages(distribution, manifestPath, helper) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const path of [manifest.llvm_package, manifest.runtime_pack])
    rmSync(resolve(dirname(manifestPath), path.replaceAll("\\", "/")), {
      recursive: true,
      force: true,
    });
  delete manifest.llvm_package;
  delete manifest.runtime_pack;
  delete manifest.runtime_packs;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const notices = join(distribution, "THIRD_PARTY_NOTICES");
  writeFileSync(
    notices,
    readFileSync(notices, "utf8").replace(llvmNotice(undefined), llvmNotice(helper)),
  );
}
