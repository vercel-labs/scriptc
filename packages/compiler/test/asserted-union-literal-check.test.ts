/* An object literal carrying an asserted type whose union-valued member
 * holds an arm the asserted target excludes converts the member in a
 * CHECKED context: the excluded arm throws the catchable TypeError the
 * lying-assertion stance promises (divergence 38), where the copy rules
 * would refuse the literal. Node erases the assertion, so this divergence is
 * not a corpus case; the conforming shapes are pinned by tests/corpus/
 * 8623-union-asserted-literal-retag.ts and asserted-literal-union-members.ts. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<ReturnType<typeof spawnSync>> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-asserted-checks-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
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

// An object literal carrying an asserted type whose union-valued member
// holds an arm the asserted target excludes: the excluded arm throws a
// TypeError the program can catch instead of refusing the literal.
function trapProgram(expression: string): string {
  return `
type ToolArgs = { arguments: unknown; id: string; name: string; type: string };
type Text = { text: string; type: string };
type Mime = { data: string; type: string };
type Content = ToolArgs[] | (Mime | Text)[];
type Message = { content: (Mime | Text)[] };
type Replacement = { content: Content };
function rebuilt(message: Message, replacement: Replacement): Message {
  return ${expression} as Message;
}
const text: Text = { type: "text", text: "hi" };
const tool: ToolArgs = { arguments: {}, id: "1", name: "bash", type: "tool" };
console.log(JSON.stringify(rebuilt({ content: [] }, { content: [text] })));
try {
  rebuilt({ content: [] }, { content: [tool] });
  console.log("unreachable");
} catch (err) {
  console.log("threw", (err as Error).name);
}
console.log("survived");
`;
}

async function expectTrap(expression: string): Promise<void> {
  const result = await run(trapProgram(expression));
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.toString()).toBe(
    '{"content":[{"type":"text","text":"hi"}]}\nthrew TypeError\nsurvived\n',
  );
}

test.skipIf(process.platform === "win32")(
  "an asserted object literal traps on a union member arm the target excludes",
  () => expectTrap("{ ...message, content: replacement.content }"),
);

// The member is itself a union holding an arm the asserted target excludes,
// so the member's conversion exists only in the assertion's checked
// context. Parentheses and a non-null assertion name the same operand, and
// the conversion answers the same way for all three forms.
function operandProgram(operand: string): string {
  return `
type A = { kind: "a"; a: number };
type B = { kind: "b"; b: number };
type S = A | B;
type Slot = A | string;
type Claim = { slot: Slot };
function rebuilt(message: Claim, source: S): Claim {
  return ${operand} as Claim;
}
const a: A = { kind: "a", a: 1 };
const b: B = { kind: "b", b: 2 };
console.log(JSON.stringify(rebuilt({ slot: "x" }, a)));
try {
  rebuilt({ slot: "x" }, b);
  console.log("unreachable");
} catch (err) {
  console.log("threw", (err as Error).name);
}
console.log("survived");
`;
}

async function expectCheckedOperand(operand: string): Promise<void> {
  const result = await run(operandProgram(operand));
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.toString()).toBe('{"slot":{"kind":"a","a":1}}\nthrew TypeError\nsurvived\n');
}

test.skipIf(process.platform === "win32")(
  "an asserted object literal converts a union member in a checked context",
  () => expectCheckedOperand("{ ...message, slot: source }"),
);

test.skipIf(process.platform === "win32")(
  "a parenthesized asserted object literal converts the same member",
  () => expectCheckedOperand("({ ...message, slot: source })"),
);

test.skipIf(process.platform === "win32")(
  "a non-null asserted object literal converts the same member",
  () => expectCheckedOperand("(({ ...message, slot: source })!)"),
);

// The member reaches the asserted target through a nested record conversion
// (`Content | string` into `WireContent | string` inside `Payload` into
// `Target`): the conversion the claim admits traps on the arm the target
// excludes, and a conforming value converts (tests/corpus/
// asserted-literal-union-members.ts pins the conforming shapes).
test.skipIf(process.platform === "win32")(
  "a member arm reached through a nested record conversion traps when excluded",
  async () => {
    const result = await run(`
type ArgText = { type: "text"; text: string };
type ArgTool = { type: "tool"; id: string; arguments: unknown };
type Content = ArgText | ArgTool;
type WireText = { type: "text"; text: string };
type WireContent = WireText;
type Payload = { body: Content | string };
type Target = { body: WireContent | string };
type Wire = { payload: Target | number };
function wrap(payload: Payload | number): Wire {
  return { payload } as Wire;
}
const text: ArgText = { type: "text", text: "hi" };
const tool: ArgTool = { arguments: {}, id: "1", type: "tool" };
console.log(JSON.stringify(wrap({ body: text })));
try {
  wrap({ body: tool });
  console.log("unreachable");
} catch (err) {
  console.log("threw", (err as Error).name);
}
console.log("survived");
`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe(
      '{"payload":{"body":{"type":"text","text":"hi"}}}\nthrew TypeError\nsurvived\n',
    );
  },
);

// The claim's checked routes must not displace a layout the source's own
// types reach: `Source` converts into the arm that drops its fields, as it
// did without the assertion, so the arm the claim alone admits (whose nested
// field traps on a value the target excludes) does not take over.
test.skipIf(process.platform === "win32")(
  "a layout the claim admits only through a nested conversion keeps the source outcome",
  async () => {
    const result = await run(`
type P = { type: "p"; p: number };
type Q = { type: "q"; q: number };
type Source = { a: number; b: number; mixed: P | Q };
type Drop = { a: number };
type Keep = { a: number; b: number; mixed: P | string };
type Slot = Drop | Keep | string;
type Claim = { slot: Slot };
function wrap(source: Source): Claim {
  return { slot: source } as Claim;
}
const q: Q = { type: "q", q: 1 };
console.log("converted", JSON.stringify(wrap({ a: 1, b: 2, mixed: q })));
`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe(
      'converted {"slot":{"a":1,"b":2,"mixed":{"type":"q","q":1}}}\n',
    );
  },
);
