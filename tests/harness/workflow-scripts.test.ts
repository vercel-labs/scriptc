// Every repository script a workflow runs must exist: a workflow that
// references a script the tree does not carry fails its job at run time
// (the green-main tag job did after a merge dropped the file).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const workflows = join(root, ".github/workflows");

test("every script a workflow runs exists in the tree", () => {
  const missing: string[] = [];
  for (const name of readdirSync(workflows)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(join(workflows, name), "utf8");
    for (const line of text.split("\n")) {
      for (const match of line.matchAll(/\bnode (scripts\/[\w./-]+\.m?js)/g)) {
        const path = match[1]!;
        // A step that runs a script only when the checkout carries it
        // (`[ ! -f path ] || node path`) asks for nothing missing.
        if (line.includes(`[ ! -f ${path} ]`)) continue;
        if (!existsSync(join(root, path))) missing.push(`${name}: ${path}`);
      }
    }
  }
  expect(missing).toEqual([]);
});
