import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { F64, VOID, type IrModule, type IrType } from "../../ir/ir.js";
import { mangleClassNew, mangleClassRelease, mangleClassRetain } from "../mangle.js";
import { emitLlvmModule } from "./emitter.js";
import { classReleaseFn, classRetainFn, classTagFn } from "./nullable-unions.js";

const loc = { file: "class-unions.ts", start: 0, end: 1 };
const tree: IrType = { kind: "union", unionId: "tree" };

/** `Leaf | Pair`, two standalone classes, and a hierarchy beside them. */
function treeModule(): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
    classes: [
      { name: "Leaf", fields: [{ name: "value", type: F64 }], methods: [], loc },
      {
        name: "Pair",
        fields: [
          { name: "left", type: tree },
          { name: "right", type: tree },
        ],
        methods: [],
        loc,
      },
      { name: "Other", fields: [{ name: "value", type: F64 }], methods: [], loc },
    ],
    unions: [
      {
        id: "tree",
        arms: [
          { kind: "object", className: "Leaf" },
          { kind: "object", className: "Pair" },
        ],
      },
    ],
  };
}

function definition(llvm: string, symbol: string): string {
  const escaped = symbol.replace(/[.$]/g, "\\$&");
  const body = new RegExp(`^define internal [^@]*@${escaped}\\([^]*?^}`, "m").exec(llvm)?.[0];
  expect(body, symbol).toBeDefined();
  return body!;
}

test("standalone arms keep their class id in the rc word's high half", () => {
  const llvm = emitLlvmModule(treeModule(), { pointerBits: 64 });
  // Arms store the id beside a count of 1; other standalone classes keep a
  // plain count.
  expect(definition(llvm, mangleClassNew("Leaf"))).toMatch(/store i64 \d{10,}, ptr %o\.vt/);
  expect(definition(llvm, mangleClassNew("Other"))).toMatch(/store i64 1, ptr %o/);
  expect(definition(llvm, mangleClassRetain("Leaf"))).toContain("load i32, ptr %o");
  expect(definition(llvm, mangleClassRetain("Other"))).toContain("load i64, ptr %o");
  // The tag reads the id at byte 4 and switches on it.
  const tag = definition(llvm, classTagFn("tree").slice(1));
  expect(tag).toContain("getelementptr inbounds i8, ptr %o, i64 4");
  expect(tag).toMatch(/switch i32 %id/);
  // 32-bit targets keep the box and the plain count.
  const llvm32 = emitLlvmModule(treeModule(), { pointerBits: 32 });
  expect(llvm32).not.toContain(classTagFn("tree"));
  expect(definition(llvm32, mangleClassRetain("Leaf"))).toContain("load i32, ptr %o");
  expect(definition(llvm32, mangleClassNew("Leaf"))).toMatch(/store i32 1, ptr %o/);
});

test("a tagged class's 32-bit count saturates at the immortal count instead of wrapping", () => {
  const llvm = emitLlvmModule(treeModule(), { pointerBits: 64 });
  // The class's and the union's retain and release, run on an rc word whose
  // count is two below the immortal all-ones count.
  const symbols = [
    [mangleClassRetain("Leaf"), "retain_leaf"],
    [mangleClassRelease("Leaf"), "release_leaf"],
    [classRetainFn("tree").slice(1), "retain_tree"],
    [classReleaseFn("tree").slice(1), "release_tree"],
  ] as const;
  let ir = "";
  for (const [symbol] of symbols) ir += `${definition(llvm, symbol)}\n\n`;
  // A last reference never reaches these: the harness aborts if one does.
  const last = [
    [`${mangleClassRelease("Leaf")}_slow`, "last_leaf"],
    [`${classReleaseFn("tree").slice(1)}.last`, "last_tree"],
  ] as const;
  for (const [symbol, name] of [...symbols, ...last])
    ir = ir.replaceAll(`@${symbol}(`, `@${name}(`);
  ir = ir.replaceAll("define internal", "define").replaceAll(" #0 ", " ");
  ir += `declare void @last_leaf(ptr)\ndeclare void @last_tree(ptr)\n`;
  const dir = mkdtempSync(join(tmpdir(), "scriptc-class-unions-"));
  try {
    writeFileSync(join(dir, "rc.ll"), ir);
    writeFileSync(
      join(dir, "main.c"),
      `#include <stdint.h>
#include <stdlib.h>
void *retain_leaf(void *);
void release_leaf(void *);
void *retain_tree(void *);
void release_tree(void *);
void last_leaf(void *o) { (void)o; abort(); }
void last_tree(void *o) { (void)o; abort(); }
static int check(void *(*retain)(void *), void (*release)(void *)) {
  const uint64_t id = (uint64_t)42 << 32;
  uint64_t word = id | 0xfffffffdu;
  retain(&word);
  if (word != (id | 0xfffffffeu)) return 1;
  retain(&word);
  if (word != (id | 0xffffffffu)) return 2;
  retain(&word);
  if (word != (id | 0xffffffffu)) return 3;
  release(&word);
  if (word != (id | 0xffffffffu)) return 4;
  word = id | 3;
  release(&word);
  if (word != (id | 2)) return 5;
  return 0;
}
int main(void) {
  int leaf = check(retain_leaf, release_leaf);
  if (leaf != 0) return leaf;
  int tree = check(retain_tree, release_tree);
  return tree == 0 ? 0 : 10 + tree;
}
`,
    );
    execFileSync("clang", [
      "-Wno-override-module",
      "-O1",
      join(dir, "rc.ll"),
      join(dir, "main.c"),
      "-o",
      join(dir, "rc"),
    ]);
    execFileSync(join(dir, "rc"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
