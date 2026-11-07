/* `Object.assign` onto a member of a discriminated union may not give the
 * member another arm's discriminant: a union member is one arm's own record,
 * and a write of another arm's discriminant would leave it holding one
 * arm's fields under another arm's name (before the guard the next narrowing
 * aborted the process). Node's one object simply becomes the other member,
 * so the refusing programs intentionally diverge and are not corpus cases;
 * the writes that keep the member's own discriminant run as in Node. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const SHAPES = `
interface Text {
  type: "text";
  text: string;
}
interface Image {
  type: "image";
  data: string;
}
function show(p: Text | Image): string {
  switch (p.type) {
    case "text":
      return "text:" + p.text;
    case "image":
      return "image:" + p.data;
  }
}
function attempt(run: () => void): void {
  try {
    run();
    console.log("assigned");
  } catch (e) {
    console.log((e as Error).name + ": " + (e as Error).message);
  }
}
`;

const REFUSAL =
  "TypeError: Object.assign cannot change the discriminant 'type' of a union member: assign a new value instead\n";

async function run(source: string): Promise<ReturnType<typeof spawnSync>> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-assign-discriminant-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, SHAPES + source);
    const built = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!built.ok) throw new Error(built.diagnostics.map((d) => d.message).join("\n"));
    return spawnSync(built.binaryPath, [], { timeout: 30_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")(
  "a union element keeps its arm when the source names another arm",
  async () => {
    const result = await run(`
const parts: (Text | Image)[] = [{ type: "image", data: "x" }];
attempt(() => {
  Object.assign(parts[0]!, { type: "text" });
});
console.log(JSON.stringify(parts[0]), show(parts[0]!));
`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe(REFUSAL + '{"type":"image","data":"x"} image:x\n');
  },
);

test.skipIf(process.platform === "win32")(
  "a whole member of another arm is refused before any field is written",
  async () => {
    const result = await run(`
function replace(parts: (Text | Image)[], i: number, next: Text): void {
  Object.assign(parts[i]!, next);
}
const parts: (Text | Image)[] = [{ type: "image", data: "x" }];
attempt(() => replace(parts, 0, { type: "text", text: "hello" }));
console.log(JSON.stringify(parts[0]), show(parts[0]!));
`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe(REFUSAL + '{"type":"image","data":"x"} image:x\n');
  },
);

test.skipIf(process.platform === "win32")(
  "a source that carries the member's own discriminant is written",
  async () => {
    const result = await run(`
function retag(parts: (Text | Image)[], i: number, type: "text" | "image", data: string): void {
  Object.assign(parts[i]!, { type, data });
}
const parts: (Text | Image)[] = [{ type: "image", data: "x" }];
const held = parts[0]!;
attempt(() => retag(parts, 0, "image", "y"));
console.log(JSON.stringify(parts[0]), show(parts[0]!), held === parts[0]);
`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe('assigned\n{"type":"image","data":"y"} image:y true\n');
  },
);

// A source that keeps properties its type does not declare (it was grown
// itself, or converted from an object with more keys) carries them outside
// its fields. Object.assign copies them in Node; the per-field write cannot,
// so the copy is refused where it runs instead of silently losing them. A
// source whose kept view only records another key order has no extra key and
// copies.
test.skipIf(process.platform === "win32")(
  "a growth source that keeps undeclared properties is refused, not truncated",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-assign-kept-source-"));
    try {
      const entry = join(dir, "main.ts");
      writeFileSync(
        entry,
        `
interface Box { a: number }
interface Wide { a: number; y: number }
function grow(target: Box, src: Wide): void { Object.assign(target, src); }
function growWide(target: Wide, src: { z: number }): void { Object.assign(target, src); }
function attempt(label: string, src: Wide): void {
  const target: Box = JSON.parse('{"a":0}') as Box;
  try {
    grow(target, src);
    console.log(label, JSON.stringify(target));
  } catch (e) {
    console.log(label, (e as { code?: string }).code, (e as Error).message, JSON.stringify(target));
  }
}
const grown: Wide = JSON.parse('{"a":1,"y":2}') as Wide;
growWide(grown, { z: 3 });
attempt("grown", grown);
attempt("parsed", JSON.parse('{"a":1,"y":2,"extra":"e"}') as Wide);
attempt("reordered", JSON.parse('{"y":2,"a":1}') as Wide);
attempt("literal", { a: 1, y: 2 });
`,
      );
      const built = await compile(entry, {
        outDir: dir,
        outPath: join(dir, "program"),
        sanitize: process.env["SCRIPTC_SAN"] === "1",
      });
      if (!built.ok) throw new Error(built.diagnostics.map((d) => d.message).join("\n"));
      const result = spawnSync(built.binaryPath, [], { timeout: 30_000 });
      const refused =
        "SC2020 Object.assign from a record that holds properties its type does not declare is not supported yet: they would not be copied [SC2020]";
      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString()).toBe(
        [
          `grown ${refused} {"a":0}`,
          `parsed ${refused} {"a":0}`,
          'reordered {"a":1,"y":2}',
          'literal {"a":1,"y":2}',
          "",
        ].join("\n"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
