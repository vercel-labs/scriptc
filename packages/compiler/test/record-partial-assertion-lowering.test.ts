import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrExpr } from "../src/ir/ir.js";

/** Every IR node in the module, in traversal order. */
async function moduleNodes<T extends { kind?: unknown }>(source: string): Promise<T[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-record-partial-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const nodes: T[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as { kind?: unknown };
      if (typeof node.kind === "string") nodes.push(node as T);
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod);
    return nodes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TR = `interface TR { content: string; truncated: boolean; truncatedBy: "lines" | "bytes" | null }
`;

test("a read of a field a partial assertion never wrote is presence-checked", async () => {
  const nodes = await moduleNodes<{
    kind: string;
    cond?: { kind: string; field?: string };
    then?: { kind: string };
    else_?: { kind: string; fn?: string; args?: IrExpr[] };
  }>(
    `${TR}function read(value: TR): string { return value.content; }
    read({ truncated: true } as TR);
    export {};
    `,
  );
  const guards = nodes.filter(
    (n) => n.kind === "ternary" && n.cond?.kind === "recordHas" && n.cond.field === "content",
  );
  expect(guards).toHaveLength(1);
  const guard = guards[0]!;
  expect(guard.then).toMatchObject({ kind: "recordGet" });
  // Node yields undefined; the view throws the catchable TypeError instead.
  expect(guard.else_).toMatchObject({
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [
      { kind: "numLit", value: 1 },
      { kind: "strLit" },
      {
        kind: "strLit",
        value: "Cannot read property 'content': the object asserted as 'TR' has no such property",
      },
    ],
  });
});

test("a field the literal writes reads without a presence check", async () => {
  const nodes = await moduleNodes<{ kind: string; cond?: { kind: string } }>(
    `${TR}function read(value: TR): boolean { return value.truncated; }
    read({ truncated: true, content: "c" } as TR);
    export {};
    `,
  );
  expect(nodes.some((n) => n.kind === "ternary" && n.cond?.kind === "recordHas")).toBe(false);
});

test("a write of a field a partial assertion never wrote throws before storing", async () => {
  const nodes = await moduleNodes<{
    kind: string;
    body?: { kind: string; cond?: { kind: string; field?: string }; else_?: unknown[] }[];
  }>(
    `${TR}function write(value: TR): void { value.content = "x"; }
    write({ truncated: true } as TR);
    export {};
    `,
  );
  const guard = nodes
    .filter((n) => n.kind === "block")
    .flatMap((n) => n.body ?? [])
    .find((s) => s.kind === "if" && s.cond?.kind === "recordHas" && s.cond.field === "content");
  expect(guard).toBeDefined();
  expect(guard!.else_).toMatchObject([
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "error.nodeThrow",
        args: [
          { kind: "numLit", value: 1 },
          { kind: "strLit" },
          {
            kind: "strLit",
            value:
              "Cannot set property 'content': the object asserted as 'TR' has no such property",
          },
        ],
      },
    },
  ]);
});

test("an optional field a partial assertion omits keeps an absent slot, read without a check", async () => {
  const nodes = await moduleNodes<{
    kind: string;
    cond?: { kind: string; field?: string };
    fields?: { name: string; value: { kind: string } }[];
  }>(
    `interface N { content: string; note?: string }
    function read(value: N): string | undefined { return value.note; }
    read({ content: "c" } as N);
    read({} as N);
    export {};
    `,
  );
  // The literal's layout holds the omitted optional field in its absent
  // state, as an ordinary record of the asserted type does.
  const literal = nodes.find(
    (n) => n.kind === "recordLit" && n.fields?.some((f) => f.name === "note") === true,
  );
  expect(literal?.fields?.find((f) => f.name === "note")?.value.kind).toBe("fieldAbsent");
  expect(
    nodes.some(
      (n) => n.kind === "ternary" && n.cond?.kind === "recordHas" && n.cond.field === "note",
    ),
  ).toBe(false);
});

test("a write of a field a partial assertion never wrote evaluates the value before the check", async () => {
  const nodes = await moduleNodes<{
    kind: string;
    localId?: string;
    body?: { kind: string; localId?: string; cond?: { kind: string; field?: string } }[];
  }>(
    `${TR}function value(): string { return "x"; }
    function write(target: TR): void { target.content = value(); }
    write({ truncated: true } as TR);
    export {};
    `,
  );
  const body = nodes
    .filter((n) => n.kind === "block")
    .map((n) => n.body ?? [])
    .find((stmts) =>
      stmts.some(
        (s) => s.kind === "if" && s.cond?.kind === "recordHas" && s.cond.field === "content",
      ),
    );
  expect(body).toBeDefined();
  const saved = body!.findIndex(
    (s) => s.kind === "varDecl" && s.localId?.includes("partialWriteValue") === true,
  );
  const check = body!.findIndex((s) => s.kind === "if");
  expect(saved).toBeGreaterThanOrEqual(0);
  expect(saved).toBeLessThan(check);
});

test("a write of an optional field a partial assertion omits needs no guard", async () => {
  const nodes = await moduleNodes<{ kind: string; cond?: { kind: string; field?: string } }>(
    `interface N { content: string; note?: string }
    function write(target: N): void { target.note = "x"; }
    write({} as N);
    write({ content: "c" });
    export {};
    `,
  );
  expect(
    nodes.some((n) => n.kind === "if" && n.cond?.kind === "recordHas" && n.cond.field === "note"),
  ).toBe(false);
});

test("a partial-field write saves its receiver when the right side may reassign it", async () => {
  const nodes = await moduleNodes<{
    kind: string;
    body?: { kind: string; localId?: string; cond?: { kind: string; field?: string } }[];
  }>(
    `${TR}function value(): string { return "x"; }
    let target: TR = { truncated: true } as TR;
    target.content = value();
    export {};
    `,
  );
  const body = nodes
    .filter((n) => n.kind === "block")
    .map((n) => n.body ?? [])
    .find((stmts) =>
      stmts.some(
        (s) => s.kind === "if" && s.cond?.kind === "recordHas" && s.cond.field === "content",
      ),
    );
  expect(body).toBeDefined();
  const receiver = body!.findIndex(
    (s) => s.kind === "varDecl" && /%partialWrite(?!Value)/.test(s.localId ?? ""),
  );
  const value = body!.findIndex(
    (s) => s.kind === "varDecl" && s.localId?.includes("partialWriteValue") === true,
  );
  expect(receiver).toBeGreaterThanOrEqual(0);
  expect(receiver).toBeLessThan(value);
});
