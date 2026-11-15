/* The dynamic requirements a Linux library reports, read by the checks that
 * keep a pack off its build toolchain's libstdc++: one probe links the
 * host's libstdc++ the ordinary way, one as a Linux pack must
 * (libnode.json's --partly-static, build-pack.mjs), and the reader must tell
 * them apart. Needs the host's C++ compiler and objdump, so it runs on Linux
 * only. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cxxRuntimeDependencies, elfRequirements } from "../scripts/elf.mjs";

const linux = process.platform === "linux";
const work = linux ? mkdtempSync(join(tmpdir(), "scriptc-libnode-elf-")) : "";

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

/** A shared library that uses the C++ runtime, linked with `flags`. */
function build(name: string, flags: string[] = []): string {
  const source = join(work, "probe.cc");
  writeFileSync(
    source,
    `#include <string>
#include <unordered_map>
extern "C" const char *probe() {
  static std::unordered_map<std::string, int> seen;
  return seen.emplace("probe", 1).first->first.c_str();
}
`,
  );
  const library = join(work, `${name}.so`);
  execFileSync(process.env["CXX"] ?? "c++", [
    "-O2",
    "-fPIC",
    "-shared",
    "-Wl,-z,defs",
    ...flags,
    source,
    "-o",
    library,
  ]);
  return library;
}

describe.skipIf(!linux)("reading a Linux library's requirements", () => {
  test("a dynamically linked C++ library needs the host's libstdc++", () => {
    const requirements = elfRequirements(build("dynamic"));
    expect(requirements.glibc).toMatch(/^2\.\d+/);
    expect(requirements.glibcxx).toMatch(/^3\.4\./);
    expect(requirements.needed).toContain("libstdc++.so.6");
    expect(cxxRuntimeDependencies(requirements)).toEqual(
      expect.arrayContaining([`GLIBCXX_${requirements.glibcxx}`, "libstdc++.so.6"]),
    );
  });

  test("a library linked with -static-libstdc++ needs no C++ runtime", () => {
    const requirements = elfRequirements(build("static", ["-static-libstdc++", "-static-libgcc"]));
    // The glibc requirement stays: only the C++ runtime is embedded.
    expect(requirements.glibc).toMatch(/^2\.\d+/);
    expect(requirements.glibcxx).toBeNull();
    expect(requirements.cxxabi).toBeNull();
    expect(requirements.needed.some((name) => name.startsWith("libstdc++"))).toBe(false);
    expect(cxxRuntimeDependencies(requirements)).toEqual([]);
  });
});
