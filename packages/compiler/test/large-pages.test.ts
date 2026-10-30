import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// --large-pages links the runtime unit that moves the executable's code onto
// transparent huge pages (scr_text_pages.c); without the flag nothing of it
// is linked. A program too small to span an aligned 2 MiB page keeps its
// code where it is and runs as before.
test.skipIf(process.platform !== "linux")(
  "--large-pages links the code-page unit only when requested",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-large-pages-"));
    try {
      const entry = join(dir, "main.ts");
      writeFileSync(entry, `console.log("pages", [1, 2, 3].map((n) => n * 2).join(","));\n`);
      const symbols = async (largePages: boolean): Promise<string> => {
        const exe = join(dir, largePages ? "large" : "plain");
        const built = await compile(entry, {
          outputKind: "exe",
          outDir: dir,
          outPath: exe,
          ...(largePages ? { largePages: true } : {}),
        });
        if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
        expect(execFileSync(exe, { encoding: "utf8" })).toBe("pages 2,4,6\n");
        return execFileSync("nm", [exe], { encoding: "utf8" });
      };
      expect(await symbols(false)).not.toContain("scr_text_large_pages");
      expect(await symbols(true)).toContain("scr_text_large_pages");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
