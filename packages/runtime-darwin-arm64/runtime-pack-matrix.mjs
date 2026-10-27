import { withWorkerRuntimeVariants } from "../runtime-pack-common/worker-matrix.mjs";
import { withLibraryRuntimeFlavors } from "../runtime-pack-common/library-matrix.mjs";
import {
  BASE_RUNTIME_SOURCES,
  OPTIONAL_RUNTIME_SOURCES,
  variantsFor,
} from "../runtime-pack-common/runtime-pack-matrix.mjs";

/**
 * The executable runtime-pack matrix. This is the single source of truth for
 * both release compilation and the generated feature predicates consumed by
 * the compiler. A predicate is intentionally data, not JavaScript, so the
 * installed compiler can validate and evaluate it deterministically.
 */

const any = (...features) => ({ any: features });
const all = (...features) => ({ all: features });

// ld64 dead-strips Mach-O symbol subsections without an ELF-style compile
// flag. Keep this checked-in metadata alongside the matrix so pack build and
// source/external linking share one documented executable recipe.
export const EXECUTABLE_SECTION_ELIMINATION = {
  compile_flags: [],
  link_flags: ["-Wl,-dead_strip"],
};

export const RUNTIME_PACK_MATRIX = withLibraryRuntimeFlavors(
  withWorkerRuntimeVariants({
    schema: "scriptc.runtime-pack-matrix.v1",
    target: {
      name: "macos-arm64",
      llvm_triple: "arm64-apple-macosx14.0.0",
      architecture: "arm64",
      object_format: "macho",
      minimum_os: "14.0",
    },
    flavors: { release: { optimization: "-O2" }, dev: { optimization: "-O0" } },
    executable_section_elimination: EXECUTABLE_SECTION_ELIMINATION,
    runtime_units: [
      ...BASE_RUNTIME_SOURCES.map((source) => ({ source, predicate: true })),
      ...OPTIONAL_RUNTIME_SOURCES.map(([source, predicate]) => ({ source, predicate })),
    ].map((unit) => ({ ...unit, variants: variantsFor(unit.source) })),
    archives: [
      { id: "quickjs", predicate: false },
      { id: "libregexp", predicate: "regex" },
      { id: "zlib", predicate: "zlibEffective" },
      { id: "brotli", predicate: all("zlib", "brotli") },
      { id: "mbedtls", predicate: any("tlsEffective", "cipher", "ecdh", "dh", "pki") },
    ],
    system_libraries: [{ name: "System", predicate: true }],
  }),
);
