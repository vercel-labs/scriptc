// The dynamic requirements of a Linux ELF library, read with objdump: the
// symbol versions its undefined symbols reference (glibc's GLIBC_x.y,
// libstdc++'s GLIBCXX_x.y and CXXABI_x.y) and the sonames it needs.
//
// The libnode build holds a pack to the oldest glibc and libstdc++ scriptc
// supports, not to the ones its build toolchain carries: a Linux pack links
// the C++ runtime statically (--partly-static, libnode.json), and these
// checks prove the library it produces references no C++ runtime version, so
// it loads on a host older than the toolchain.
import { execFileSync } from "node:child_process";

/** `objdump -T`: the dynamic symbol table, with version references. */
function dynamicSymbols(library) {
  return execFileSync("objdump", ["-T", library], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** `objdump -p`: the dynamic section, whose NEEDED entries name the shared
 * libraries the loader must find. */
function dynamicSection(library) {
  return execFileSync("objdump", ["-p", library], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

/** The highest version of `name` whose `name_x.y` symbol version the
 * library's undefined symbols reference, or null when there is none. */
function highestVersion(undefinedSymbols, name) {
  const versions = [
    ...new Set(
      (undefinedSymbols.match(new RegExp(`\\b${name}_(\\d+(?:\\.\\d+)*)`, "g")) ?? []).map(
        (match) => match.slice(name.length + 1),
      ),
    ),
  ];
  versions.sort(compareVersions);
  return versions.at(-1) ?? null;
}

/**
 * The dynamic requirements of a Linux shared library:
 * `glibc` is the highest GLIBC_x.y symbol version its undefined symbols
 * reference (the oldest glibc that can load it), `glibcxx` and `cxxabi` are
 * the highest libstdc++ versions (null when the C++ runtime is linked
 * statically), and `needed` lists the sonames the loader needs.
 *
 * @param {string} library
 * @returns {{ glibc: string | null, glibcxx: string | null, cxxabi: string | null, needed: string[] }}
 */
export function elfRequirements(library) {
  const undefinedSymbols = dynamicSymbols(library)
    .split("\n")
    .filter((line) => line.includes("*UND*"))
    .join("\n");
  const needed = dynamicSection(library)
    .split("\n")
    .map((line) => /^\s+NEEDED\s+(\S+)$/.exec(line)?.[1])
    .filter((name) => name !== undefined);
  return {
    glibc: highestVersion(undefinedSymbols, "GLIBC"),
    glibcxx: highestVersion(undefinedSymbols, "GLIBCXX"),
    cxxabi: highestVersion(undefinedSymbols, "CXXABI"),
    needed,
  };
}

/** The C++ runtime dependencies in `requirements`, named for a message:
 * `GLIBCXX_3.4.33`, `CXXABI_1.3.15`, `libstdc++.so.6`. Empty when the
 * library carries its own libstdc++ and needs nothing from the host.
 *
 * @param {ReturnType<typeof elfRequirements>} requirements
 */
export function cxxRuntimeDependencies(requirements) {
  const { glibcxx, cxxabi, needed } = requirements;
  return [
    glibcxx === null ? null : `GLIBCXX_${glibcxx}`,
    cxxabi === null ? null : `CXXABI_${cxxabi}`,
    needed.find((name) => name.startsWith("libstdc++")) ?? null,
  ].filter((entry) => entry !== null);
}
