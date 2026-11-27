import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  VOID,
  type IrFunction,
  type IrLocal,
  type SrcLoc,
} from "../../ir/ir.js";
import { LlvmDebugInfo } from "./debug-info.js";

const file = "/source/日本/main.ts";
const text = "function example(value: number) {\r\n  const outer = 1;\n  { const inner = 2; }\n}\n";
const loc: SrcLoc = { file, start: 0, end: text.length };
const at = (word: string): SrcLoc => ({
  file,
  start: text.indexOf(word),
  end: text.indexOf(word) + word.length,
});
function local(name: string, scope = loc): IrLocal {
  return { id: name + ".0", name, type: F64, mutable: true, source: { loc: at(name), scope } };
}
function fn(locals: IrLocal[] = []): IrFunction {
  return { name: "example", params: [], locals, returnType: VOID, body: [], loc };
}

test("missing sources leave functions and bindings without invented positions", () => {
  const debug = new LlvmDebugInfo(file, new Map());
  expect(debug.function(fn())).toBeNull();
  expect(debug.local(local("outer"), null)).toBeNull();
  expect(debug.location(loc, null)).toBeNull();
  expect(debug.global({ id: "g", name: "g", type: F64, mutable: false })).toBeNull();
  expect(debug.render()).not.toContain("DILocation");
});

test("parameters retain argument numbers and source positions across CRLF", () => {
  const debug = new LlvmDebugInfo(file, new Map([[file, text]]));
  const value = local("value");
  const scope = debug.function(fn([value]));
  const binding = debug.local(value, scope, 1);
  expect(binding).not.toBeNull();
  expect(debug.render()).toContain('name: "value", arg: 1');
  expect(debug.render()).toContain("line: 1, column: 18");
  expect(debug.location(at("outer"), scope)).not.toBeNull();
  expect(debug.render()).toContain("line: 2, column: 9");
  expect(debug.render()).toContain('filename: "main.ts"');
  expect(debug.render()).toContain('directory: "/source/\\E6\\97\\A5\\E6\\9C\\AC"');
});

test("nested lexical scopes bind inner locals to the smallest containing block", () => {
  const nested: SrcLoc = { file, start: text.indexOf("{ const"), end: text.indexOf("; }") + 3 };
  const outer = local("outer");
  const inner = local("inner", nested);
  const debug = new LlvmDebugInfo(file, new Map([[file, text]]));
  const scope = debug.function(fn([outer, inner]));
  debug.local(outer, scope);
  debug.local(inner, scope);
  const rendered = debug.render();
  const block = /(!\d+) = distinct !DILexicalBlock\(/.exec(rendered)?.[1];
  expect(block).toBeDefined();
  expect(rendered).toContain(`name: "outer", scope: ${scope}`);
  expect(rendered).toContain(`name: "inner", scope: ${block}`);
});

test("captured locals use function scope while ordinary duplicate scopes intern", () => {
  const nested: SrcLoc = { file, start: text.indexOf("{ const"), end: text.indexOf("; }") + 3 };
  const inner = local("inner", nested);
  inner.boxed = true;
  const second = { ...inner, id: "other.0", name: "other" };
  const captured = { ...inner, id: "captured.0", name: "captured" };
  const func = fn([inner, second, captured]);
  func.captures = [{ localId: captured.id, name: captured.name, type: F64 }];
  const debug = new LlvmDebugInfo(file, new Map([[file, text]]));
  const scope = debug.function(func);
  debug.local(captured, scope, 0, true);
  expect(debug.render().match(/distinct !DILexicalBlock\(/g)).toHaveLength(1);
  expect(debug.render()).toContain(`name: "captured", scope: ${scope}`);
});

test.each([32, 64])("boxed and TDZ locals use honest storage descriptions (%i-bit)", (bits) => {
  const debug = new LlvmDebugInfo(file, new Map([[file, text]]), bits);
  const boxed: IrLocal = { ...local("outer"), boxed: true };
  const tdz: IrLocal = { ...local("inner"), boxed: true, tdz: true };
  const scope = debug.function(fn([boxed, tdz]));
  const real = debug.local(boxed, scope);
  const opaque = debug.local(tdz, scope);
  expect(real?.expression).toBe(
    `!DIExpression(DW_OP_deref, DW_OP_plus_uconst, ${bits === 32 ? 24 : 40})`,
  );
  expect(opaque?.expression).toBe("!DIExpression()");
  expect(debug.render()).toContain('name: "ScrBox", flags: DIFlagFwdDecl');
});

test("globals are attached to the correct compilation units and render is stable", () => {
  const other = "/source/other.ts";
  const otherLoc = { file: other, start: 0, end: 5 };
  const debug = new LlvmDebugInfo(
    file,
    new Map([
      [file, text],
      [other, "const other = 1;"],
    ]),
  );
  const first = debug.global({
    id: "first",
    name: "first",
    type: STRING,
    mutable: false,
    source: { loc, scope: loc },
  });
  const second = debug.global({
    id: "second",
    name: "second",
    type: BOOL,
    mutable: true,
    source: { loc: otherLoc, scope: otherLoc },
  });
  const rendered = debug.render();
  expect(rendered).toContain(`!{${first}}`);
  expect(rendered).toContain(`!{${second}}`);
  expect(rendered.match(/distinct !DICompileUnit\(/g)).toHaveLength(2);
  expect(debug.render()).toBe(rendered);
});

test("locations intern per file and scope and clamp columns to DWARF limits", () => {
  const long = " ".repeat(70000) + "value";
  const other = "/source/other.ts";
  const debug = new LlvmDebugInfo(
    file,
    new Map([
      [file, text],
      [other, long],
    ]),
  );
  const scope = debug.function(fn());
  const pos = { file: other, start: 70000, end: 70005 };
  const first = debug.location(pos, scope);
  expect(debug.location(pos, scope)).toBe(first);
  expect(debug.location({ file: "missing.ts", start: 0, end: 0 }, scope)).toBeNull();
  expect(debug.render()).toContain("column: 65535");
  expect(debug.render()).toContain("DILexicalBlockFile");
});

test.each([32, 64])(
  "nullable reference types describe tags and ABI payload offsets (%i-bit)",
  (bits) => {
    const debug = new LlvmDebugInfo(file, new Map([[file, text]]), bits, [
      { id: "value", arms: [STRING, { kind: "undefinedT" }] },
    ]);
    const value: IrLocal = { ...local("value"), type: { kind: "union", unionId: "value" } };
    const scope = debug.function(fn([value]));
    debug.local(value, scope);
    const rendered = debug.render();
    expect(rendered).toContain('!DIEnumerator(name: "undefined", value: 1');
    expect(rendered).toContain(`offset: ${(bits === 32 ? 24 : 40) * 8}`);
    expect(rendered).toContain('name: "ScrUnion_value"');
  },
);

test("a sourcePathMap renames the emitted file, not the text it looks up", () => {
  const debug = new LlvmDebugInfo(file, new Map([[file, text]]), 64, [], new Map(), (path) =>
    path === file ? "/project/src/lib.ts" : path,
  );
  expect(debug.function(fn())).not.toBeNull();
  const rendered = debug.render();
  expect(rendered).toContain('filename: "lib.ts"');
  expect(rendered).toContain('directory: "/project/src"');
  expect(rendered).not.toContain("/source/");
});
