// Object literals asserted to a discriminated union whose own fields match
// another member's fields: the discriminant selects the member.
interface Loc {
  start: number;
}
type Expr = { kind: "num"; value: number; loc: Loc } | { kind: "str"; text: string; loc: Loc };
type Stmt =
  | { kind: "return"; value: Expr | null; awaited?: true; loc: Loc }
  | { kind: "throw"; value: Expr; loc: Loc }
  | { kind: "if"; cond: Expr; then: Stmt[]; loc: Loc };

function show(stmt: Stmt): string {
  switch (stmt.kind) {
    case "return":
      return `return${stmt.awaited ? " awaited" : ""} ${stmt.value === null ? "-" : stmt.value.kind}`;
    case "throw":
      return `throw ${stmt.value.kind}`;
    case "if":
      return `if ${stmt.cond.kind} { ${stmt.then.map(show).join("; ")} }`;
  }
}

function guarded(value: Expr, loc: Loc): Stmt {
  return { kind: "if", cond: value, then: [{ kind: "return", value, loc } as Stmt], loc };
}

function branches(reflect: boolean, value: Expr, loc: Loc): Stmt[] {
  return [
    ...(reflect
      ? [{ kind: "return", value, loc } as Stmt]
      : [{ kind: "throw", value, loc } as Stmt, { kind: "return", value: null, loc } as Stmt]),
  ];
}

const loc: Loc = { start: 0 };
const num: Expr = { kind: "num", value: 1, loc };
const str: Expr = { kind: "str", text: "x", loc };
console.log(show(guarded(num, loc)));
console.log(branches(true, str, loc).map(show).join(" | "));
console.log(branches(false, num, loc).map(show).join(" | "));
const listed: Stmt[] = [{ kind: "return", value: str, loc } as Stmt, { kind: "throw", value: num, loc }];
console.log(listed.map(show).join(" | "), listed.map((stmt) => stmt.kind).join(","));
