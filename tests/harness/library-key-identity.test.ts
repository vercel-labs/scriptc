/* A library build does not link the adoption unit, so a dynamic value taken
 * as a native collection key cannot be adopted there. The key conversion
 * must refuse at run time instead of storing a copy that no other name
 * shares (repeated insertions of the same value would become distinct keys).
 * The emitted library carries the refusal, and it does not reference the
 * adoption unit it does not link. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compileLibrary } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixture = join(repoRoot, "tests/library-mode/key-identity");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/library-key-identity");

test(
  "a library key conversion refuses instead of storing an unshared copy",
  { timeout: 300_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const profile = JSON.parse(readFileSync(join(fixture, "profile.json"), "utf8"));
    profile.entry = join(fixture, profile.entry);
    const profilePath = join(outDir, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    const result = await compileLibrary({ profilePath, outDir });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const llvm = readFileSync(join(outDir, "lib.lib.ll"), "utf8");
    expect(llvm).toContain(
      "a dynamic collection key whose value cannot be adopted as the key type is not supported yet",
    );
    // The refusal is the library's own helper: the adoption unit it cannot
    // link is not referenced.
    expect(llvm).not.toContain("call void @scr_dyn_adopt_key");
    const undefinedSymbols = execFileSync("nm", ["-u", join(outDir, "lib.lib.a")], {
      encoding: "utf8",
    });
    expect(undefinedSymbols).not.toContain("scr_dyn_adopt_key");
  },
);
