import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const src = join(import.meta.dirname, "..", "src");

/* Ordinary objects keep their properties behind the object core: units
 * outside it read and adjust them through the scr_dyn.h own-property
 * accessors (scr_dyn_obj_count, scr_dyn_obj_prop_at, ...), so the core can
 * change how it stores them. */
const CORE = new Set(["scr_json.c", "scr_js_object.c", "scr_dyn.h"]);

test("only the object core reads ordinary objects' storage", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(src)) {
    if (!/\.(c|h)$/.test(name) || name.endsWith(".test.c") || CORE.has(name)) continue;
    const lines = readFileSync(join(src, name), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/\bv\.obj\.(entries|slots|layout|len|cap|index)\b/.test(line))
        offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});
