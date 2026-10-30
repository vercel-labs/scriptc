// Mapping a recursive variant before the whole union preserves separate
// layout ids for bin and logical. Later inferred literals can share either.
type Expr =
  | { kind: "number"; value: number }
  | { kind: "bin"; op: "+" | "==="; left: Expr; right: Expr }
  | { kind: "logical"; op: "&&" | "||"; left: Expr; right: Expr }
  | { kind: "nullish"; left: Expr; right: Expr }
  | { kind: "ternary"; cond: Expr; then: Expr; else_: Expr };

function binary(value: Expr & { kind: "bin" }): Expr { return value; }

function inferred(left: Expr, right: Expr): Expr {
  const value = { kind: "bin" as const, op: "+" as const, left, right };
  return value;
}

function callback(left: Expr, right: Expr): () => Expr {
  return () => ({ kind: "bin" as const, op: "+" as const, left, right });
}

function build(left: Expr, right: Expr, conditional: boolean): Expr {
  const missing = conditional ? {
    kind: "ternary" as const,
    cond: { kind: "bin" as const, op: "===" as const, left, right },
    then: left,
    else_: right,
  } : left;
  return missing;
}

function inspect(root: Expr): void {
  const pending = [root];
  while (pending.length !== 0) {
    const e = pending.pop()!;
    if (e.kind === "logical" || e.kind === "nullish") {
      console.log(e.kind);
      pending.push(e.right, e.left);
    } else if (e.kind === "ternary") {
      pending.push(e.else_, e.then, e.cond);
    } else {
      console.log(e.kind);
    }
  }
}
const left: Expr = { kind: "number", value: 1 };
const right: Expr = { kind: "number", value: 2 };
console.log(binary({ kind: "bin", op: "+", left, right }).kind);
inspect(build(left, right, true));
inspect(build(left, right, false));
inspect(inferred(left, right));
inspect(callback(left, right)());
inspect({ kind: "logical", op: "&&", left, right });
inspect({ kind: "nullish", left, right });

// Native compilation of array search synthesizes a branching expression
// with a nested binary comparison, exercising this conversion in the compiler.
function packageSegment(path: string): number {
  return path.split("/").lastIndexOf("node_modules");
}
console.log(packageSegment("/workspace/node_modules/package"));
console.log(packageSegment("/workspace/src"));

// Inferred callback records can share another variant's exact layout or
// width-convert to it. The discriminator still owns optional slot completion.
type Statement =
  | { kind: "set"; value: number; propertyOp?: "set" | "define" }
  | { kind: "throw"; value: number }
  | { kind: "block"; body: Statement[] };
function statements(values: number[]): Statement[] {
  return values.map(value => ({ kind: "set", value }));
}
function extraStatements(values: number[]): Statement[] {
  return values.map(value => ({ kind: "set", value, extra: true }));
}
function copyStatement(statement: Statement): Statement {
  switch (statement.kind) {
    case "set": return { ...statement, value: statement.value + 1 };
    case "throw": return { ...statement, value: statement.value + 2 };
    case "block": return { ...statement, body: statement.body.map(copyStatement) };
  }
}
for (const body of [statements([1, 2]), extraStatements([3, 4])]) {
  const copied = copyStatement({ kind: "block", body });
  if (copied.kind === "block") {
    for (const statement of copied.body) {
      if (statement.kind === "set") console.log(statement.kind, statement.value, statement.propertyOp);
    }
  }
}
function maybeStatement(value: number): { kind: "set" | "throw"; value: number } | undefined {
  return value < 0 ? undefined : { kind: value === 0 ? "throw" : "set", value };
}
for (const value of [-1, 0, 1]) {
  const statement: Statement | undefined = maybeStatement(value);
  if (statement !== undefined) {
    const copied = copyStatement(statement);
    if (copied.kind !== "block") console.log(copied.kind, copied.value);
  } else console.log("missing");
}
