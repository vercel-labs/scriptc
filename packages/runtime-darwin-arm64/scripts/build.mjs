#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import {
  copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RUNTIME_PACK_MATRIX } from "../runtime-pack-matrix.mjs";

const run = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runtimeRoot = join(repoRoot, "packages/runtime");
const runtimeSrc = join(runtimeRoot, "src");
const vendorRoot = join(runtimeRoot, "vendor");
const outputRoot = join(packageRoot, "artifacts");
const manifestPath = join(packageRoot, "runtime-pack.json");
const sourcePathFlags = [`-ffile-prefix-map=${repoRoot}=.`];

if (process.platform !== "darwin" || process.arch !== "arm64") {
  process.stdout.write("@scriptc/runtime-darwin-arm64: skipped on this host\n");
  process.exit(0);
}

const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const compiler = process.env.CC ?? "clang";
const archiver = process.env.AR ?? "ar";
const compilerVersion = (await run(compiler, ["--version"])).stdout.split("\n", 1)[0].trim();
const commonFlags = [
  "-target", RUNTIME_PACK_MATRIX.target.llvm_triple,
  "-std=c11", "-pthread", "-fno-math-errno", "-fno-strict-aliasing",
  "-Wno-deprecated-declarations", "-I", runtimeSrc,
];
const quickjs = join(vendorRoot, "quickjs-ng");
const zlib = join(vendorRoot, "zlib");
const mbedtls = join(vendorRoot, "mbedtls");
const QJS_SOURCES = ["dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"];
const LRE_SOURCES = ["libregexp.c", "libunicode.c"];
const ZLIB_SOURCES = [
  "adler32.c", "compress.c", "crc32.c", "deflate.c", "infback.c",
  "inffast.c", "inflate.c", "inftrees.c", "trees.c", "uncompr.c", "zutil.c",
];

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function compile(source, output, flags) {
  await mkdir(dirname(output), { recursive: true });
  await run(compiler, [...sourcePathFlags, ...flags, "-c", source, "-o", output]);
}

async function parallel(items, task) {
  const width = Math.max(1, Math.min(8, availableParallelism()));
  for (let i = 0; i < items.length; i += width) {
    await Promise.all(items.slice(i, i + width).map(task));
  }
}

async function archive(id, sources, sourceRoot, flags) {
  const root = join(outputRoot, "vendor", id);
  const objectRoot = join(root, "objects");
  await parallel(sources, async (source) => {
    await compile(join(sourceRoot, source), join(objectRoot, source.replace(/\.c$/, ".o")), flags);
  });
  const output = join(root, `libscriptc-${id}.a`);
  const objects = sources.map((source) => join(objectRoot, source.replace(/\.c$/, ".o")));
  await run(archiver, ["rcs", output, ...objects]);
  await rm(objectRoot, { recursive: true, force: true });
  return {
    id,
    path: output.slice(packageRoot.length + 1),
    sha256: await sha256(output),
    size: (await stat(output)).size,
  };
}

const privateRoot = `${outputRoot}.tmp-${process.pid}`;
await rm(privateRoot, { recursive: true, force: true });
await rm(outputRoot, { recursive: true, force: true });
await mkdir(privateRoot, { recursive: true });
// Build under the final path spelling so object metadata remains stable. The
// compiler prefix map above also keeps __FILE__ and any debug paths independent
// of the producer's checkout location.
await rename(privateRoot, outputRoot);

try {
  const flavors = {};
  for (const [flavor, flavorSpec] of Object.entries(RUNTIME_PACK_MATRIX.flavors)) {
    const units = [];
    for (const unit of RUNTIME_PACK_MATRIX.runtime_units) {
      const variants = [];
      for (const variant of unit.variants) {
        const variantName = variant.id === "default" ? "default" : variant.id;
        const output = join(outputRoot, flavor, "runtime", variantName, unit.source.replace(/\.c$/, ".o"));
        const includeFlags = [
          ...(unit.source === "scr_regex.c" || variant.defines.includes("SCR_DYNAMIC")
            ? ["-I", quickjs]
            : []),
          ...(unit.source === "scr_tls.c" ? ["-I", join(mbedtls, "include")] : []),
          ...(unit.source === "scr_zlib.c" || unit.source === "scr_fetch.c"
            ? ["-I", zlib]
            : []),
        ];
        await compile(join(runtimeSrc, unit.source), output, [
          ...commonFlags, flavorSpec.optimization,
          ...variant.defines.map((define) => `-D${define}`),
          ...includeFlags,
        ]);
        variants.push({
          id: variant.id,
          when: variant.when,
          defines: variant.defines,
          path: output.slice(packageRoot.length + 1),
          sha256: await sha256(output),
          size: (await stat(output)).size,
        });
      }
      units.push({ source: unit.source, predicate: unit.predicate, variants });
    }
    flavors[flavor] = { optimization: flavorSpec.optimization, runtime_units: units };
  }

  const mbedtlsSources = (await readdir(join(mbedtls, "library")))
    .filter((name) => !name.startsWith(".") && name.endsWith(".c"))
    .sort();
  const archives = [
    await archive("quickjs", QJS_SOURCES, quickjs, [
      "-target", RUNTIME_PACK_MATRIX.target.llvm_triple, "-std=gnu11",
      "-fvisibility=hidden", "-funsigned-char", "-DQUICKJS_NG_BUILD",
      "-D_GNU_SOURCE", "-DNDEBUG", "-Os", "-I", quickjs,
    ]),
    await archive("libregexp", LRE_SOURCES, quickjs, [
      "-target", RUNTIME_PACK_MATRIX.target.llvm_triple, "-std=c11", "-Os", "-I", quickjs,
    ]),
    await archive("zlib", ZLIB_SOURCES, zlib, [
      "-target", RUNTIME_PACK_MATRIX.target.llvm_triple, "-std=c11", "-Os", "-I", zlib,
    ]),
    await archive("mbedtls", mbedtlsSources, join(mbedtls, "library"), [
      "-target", RUNTIME_PACK_MATRIX.target.llvm_triple, "-std=c11", "-Os",
      "-I", join(mbedtls, "include"), "-I", join(mbedtls, "library"),
    ]),
  ];
  const archiveSpecs = new Map(RUNTIME_PACK_MATRIX.archives.map((entry) => [entry.id, entry]));
  const licensed = [
    [join(runtimeRoot, "LICENSE"), "artifacts/licenses/scriptc-runtime.txt", "Apache-2.0"],
    [join(quickjs, "LICENSE"), "artifacts/licenses/quickjs-ng.txt", "MIT"],
    [join(vendorRoot, "ryu", "LICENSE-Boost"), "artifacts/licenses/ryu.txt", "BSL-1.0"],
    [join(zlib, "LICENSE"), "artifacts/licenses/zlib.txt", "Zlib"],
    [join(mbedtls, "LICENSE"), "artifacts/licenses/mbedtls.txt", "Apache-2.0"],
  ];
  await Promise.all(licensed.map(async ([source, destination]) => {
    const output = join(packageRoot, destination);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(source, output);
  }));
  const manifest = {
    schema: "scriptc.runtime-pack.v1",
    format: 1,
    package: packageManifest.name,
    version: packageManifest.version,
    target: RUNTIME_PACK_MATRIX.target,
    runtime_abi: { version: 1, marker: "scr_runtime_abi_v1" },
    compiler: {
      command: compiler,
      identity: compilerVersion,
      target: RUNTIME_PACK_MATRIX.target.llvm_triple,
    },
    macros: {
      executable: ["SCR_DYNAMIC", "SCR_TEXT_DECODER_LEGACY"],
      excluded: ["SCR_LIB", "SCR_THREAD_INSTANCES", "SCR_RC_AUDIT", "SCR_ASAN_FIBERS"],
      sanitizer: "external-toolchain-required",
    },
    flavors,
    archives: archives.map((entry) => ({ ...entry, predicate: archiveSpecs.get(entry.id).predicate })),
    system_libraries: RUNTIME_PACK_MATRIX.system_libraries,
    licenses: licensed.map(([, path, license]) => ({ path, license })),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `built ${packageManifest.name}@${packageManifest.version}: ` +
    `${Object.keys(flavors).length} flavors, ${archives.length} vendor archives\n`,
  );
} catch (error) {
  await rm(outputRoot, { recursive: true, force: true });
  await rm(manifestPath, { force: true });
  throw error;
}
