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
