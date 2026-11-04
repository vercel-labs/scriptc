// A `satisfies` expression inside a conditional maps like its operand: the
// literal converts to its place in the conditional's type, so `T | null`,
// `T | undefined` and `T | T` conditionals take it exactly as they take a
// plain literal or a value of type T. The compiler's own sources spell the
// same shape (timers.ts, element-access.ts, fs-paths.ts).

interface Row {
  readonly paths: readonly number[];
  readonly pathsFirst: boolean;
  readonly names?: readonly string[];
}

type Expr = { kind: "numLit"; value: number } | { kind: "name"; text: string };

const gates: boolean[] = [true, false];

function describe(e: Expr | null): string {
  return e === null ? "null" : e.kind === "numLit" ? `num:${e.value}` : `name:${e.text}`;
}

function maybeExpr(e: Expr | undefined): string {
  return e === undefined ? "undefined" : describe(e);
}

// Argument position: the conditional is a call argument of the union type.
function takeArg(e: Expr | null): string {
  return describe(e);
}

// Return position.
function makeExpr(gate: boolean): Expr | null {
  return gate ? ({ kind: "numLit", value: 7 } satisfies Expr) : null;
}

// The timers.ts shape: a `satisfies` literal arm beside a value of the
// union type, selected by a discriminant check.
function widen(delay: Expr, key: string): Expr {
  return delay.kind === key ? ({ kind: "numLit", value: 1 } satisfies Expr) : delay;
}

// The fs-paths.ts shape: a `satisfies` literal of the required fields beside
// an undefined arm, where the target interface also has an optional field.
function fsRow(module: string, member: string): Row | undefined {
  return module === "fs/promises"
    ? ({ paths: [0], pathsFirst: true } satisfies Row)
    : module === "fs" && member === "existsSync"
      ? ({ paths: [0], pathsFirst: true } satisfies Row)
      : undefined;
}

for (const gate of gates) {
  // Inferred type (Expr | null) and annotated type.
  const a = gate ? ({ kind: "numLit", value: 1 } satisfies Expr) : null;
  const b: Expr | null = gate ? ({ kind: "name", text: "b" } satisfies Expr) : null;
  const c: Expr | undefined = gate ? ({ kind: "name", text: "c" } satisfies Expr) : undefined;
  // The false arm keeps its identity, as with a plain literal.
  const keep: Expr = { kind: "name", text: "keep" };
  const d = gate ? ({ kind: "numLit", value: 2 } satisfies Expr) : keep;

  console.log(`${gate} a=${describe(a)} b=${describe(b)} c=${maybeExpr(c)}`);
  console.log(`${gate} d=${describe(d)} same=${String(d === keep)}`);
  console.log(`${gate} arg=${takeArg(gate ? ({ kind: "name", text: "x" } satisfies Expr) : null)}`);
  console.log(`${gate} ret=${describe(makeExpr(gate))}`);
}

console.log(`widen=${describe(widen({ kind: "name", text: "w" }, "numLit"))}`);
console.log(`widen=${describe(widen({ kind: "numLit", value: 9 }, "numLit"))}`);

const cases: [string, string][] = [
  ["fs/promises", "access"],
  ["fs", "existsSync"],
  ["fs", "readFileSync"],
];

for (const [module, member] of cases) {
  const row = fsRow(module, member);
  console.log(
    row === undefined
      ? `${module}.${member} none`
      : `${module}.${member} paths=${row.paths.length} first=${String(row.pathsFirst)} names=${row.names === undefined ? "none" : "some"}`,
  );
}
