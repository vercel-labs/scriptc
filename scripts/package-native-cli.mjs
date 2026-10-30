import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundlePlatformPackages, llvmNotice, platformPackagesOf } from "./native-cli-bundle.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = resolve(process.argv[2] ?? join(repository, "packages"));
const output = resolve(process.argv[3] ?? join(repository, ".scriptc/releases"));
mkdirSync(output, { recursive: true });
const compiler = JSON.parse(readFileSync(join(packages, "compiler/package.json"), "utf8"));
const sums = [];

for (const name of readdirSync(packages)
  .filter((name) => name.startsWith("cli-"))
  .sort()) {
  const source = join(packages, name);
  const identity = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (identity.version !== compiler.version)
    throw new Error(`native CLI version mismatch: ${name}`);
  const stage = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-release-"),
  );
  try {
    cpSync(join(source, "package.json"), join(stage, "package.json"));
    const distribution = join(stage, "dist");
    cpSync(join(source, "dist"), distribution, { recursive: true });
    const bin = join(distribution, "bin");
    const binary = join(bin, name.includes("win32-") ? "scriptc.exe" : "scriptc");
    const manifest = JSON.parse(readFileSync(binary + ".json", "utf8"));
    const hostPath = (value) => (name.includes("win32-") ? value.replaceAll("\\", "/") : value);
    // The standalone archive bundles the LLVM helper and runtime pack that
    // the npm platform package depends on.
    if (manifest.llvm_package === undefined) {
      const { helper, runtime } = platformPackagesOf(identity);
      const paths = bundlePlatformPackages({
        packages,
        distribution,
        helper,
        runtime,
        windows: name.includes("win32-"),
      });
      manifest.llvm_package = paths.llvm_package;
      manifest.runtime_pack = paths.runtime_pack;
      manifest.runtime_packs = [{ target: manifest.target, path: paths.runtime_pack }];
      writeFileSync(binary + ".json", JSON.stringify(manifest, null, 2) + "\n");
      const notices = join(distribution, "THIRD_PARTY_NOTICES");
      writeFileSync(
        notices,
        readFileSync(notices, "utf8").replace(llvmNotice(helper), llvmNotice(undefined)),
      );
    }
    // GitHub artifact transport drops executable modes. Restore the native
    // tools before validating and creating the standalone archive.
    for (const path of [
      binary,
      resolve(bin, hostPath(manifest.ts7)),
      resolve(bin, hostPath(manifest.tsc_ts)),
      resolve(bin, hostPath(manifest.comptime)),
      join(
        resolve(bin, hostPath(manifest.llvm_package)),
        "bin",
        name.includes("win32-") ? "scriptc-llvm-codegen.exe" : "scriptc-llvm-codegen",
      ),
    ]) {
      chmodSync(path, 0o755);
    }
    execFileSync(process.execPath, [join(repository, "scripts/verify-native-cli.mjs"), stage], {
      stdio: "inherit",
    });
    const archive = join(output, `scriptc-${identity.version}-${name.slice(4)}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", distribution, "."], { stdio: "inherit" });
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    sums.push(`${digest}  ${basename(archive)}`);
    console.log(archive);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
if (sums.length === 0) throw new Error("no native CLI packages found");
writeFileSync(join(output, "SHA256SUMS"), sums.join("\n") + "\n");
