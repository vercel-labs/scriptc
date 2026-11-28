/* A regex literal's template is a static %ScrRegex the runtime compiles into
 * and, since the simple-scan cache, writes a slot of — the record in
 * scr_regex.h and the emitter's type are one ABI. A field added to the header
 * without the emitter (or the other way round) leaves every literal's
 * template undersized, which sanitized builds catch only where a literal is
 * matched. This compares the two field lists by name and order. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

function headerFields(): string[] {
  const text = readFileSync(join(repoRoot, "packages/runtime/src/scr_regex.h"), "utf8");
  const start = text.indexOf("typedef struct ScrRegex {");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("} ScrRegex;", start);
  expect(end).toBeGreaterThan(start);
  const body = text
    .slice(start + "typedef struct ScrRegex {".length, end)
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    const code = line.replace(/\/\/.*$/, "").trim();
    if (code === "" || code === "*") continue;
    for (const declaration of code.split(";")) {
      const match = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(declaration.trim());
      if (match) fields.push(match[1]!);
    }
  }
  return fields;
}

function emittedTypes(): string[] {
  const text = readFileSync(
    join(repoRoot, "packages/compiler/src/backend/llvm/emit-module.ts"),
    "utf8",
  );
  const match = /`%ScrRegex = type \{([^`]*)\}`/.exec(text);
  expect(match, "the emitter's %ScrRegex type definition").not.toBeNull();
  return match![1]!.split(",").map((t) => t.trim());
}

const SCALARS: Record<string, string> = { rc: "size", last_index: "double" };

describe("the emitted regex template record", () => {
  test("carries one field per struct field, in the header's order", () => {
    const fields = headerFields();
    const types = emittedTypes();
    expect(types.length).toBe(fields.length);
    fields.forEach((name, index) => {
      const expected =
        SCALARS[name] === "double" ? "double" : SCALARS[name] === "size" ? "sizeType" : "ptr";
      const actual = types[index]!.includes("sizeType") ? "sizeType" : types[index];
      expect(actual, `field ${index} (${name})`).toBe(expected);
    });
  });

  test("the header's last field is the simple-scan cache the runtime writes", () => {
    expect(headerFields().at(-1)).toBe("simple");
  });
});
