// A binding initialized or assigned from a stale narrowed read inherits the
// stale narrowing: after reset() stores a Lit, TypeScript still types
// `current` as Neg, and `const held: Expr = current` narrows `held` to Neg
// too. Reads of such bindings observe the value stored now, as Node does:
// members every arm has read the current arm, and an arm-only member of
// the wrong arm throws the catchable TypeError instead of reading another
// record's slot.
type Lit = { kind: "lit"; value: number };
type Neg = { kind: "neg"; operand: Expr };
type Expr = Lit | Neg;

function show(e: Expr): string {
  return e.kind === "lit" ? String(e.value) : `-${show(e.operand)}`;
}

function fromInitializer(replace: boolean): string {
  let current: Expr | null = null;
  const reset = (): void => {
    current = { kind: "lit", value: 7 };
  };
  current = { kind: "neg", operand: { kind: "lit", value: 1 } };
  if (replace) reset();
  if (current === null) return "null";
  const held: Expr = current;
  const kind = held.kind;
  try {
    return `${kind} ${show(held.operand)}`;
  } catch (e) {
    return `${kind} caught ${(e as Error).name}`;
  }
}

function fromAssignment(replace: boolean): string {
  let current: Expr | null = null;
  const reset = (): void => {
    current = { kind: "lit", value: 8 };
  };
  current = { kind: "neg", operand: { kind: "lit", value: 2 } };
  if (replace) reset();
  let held: Expr = { kind: "lit", value: 0 };
  if (current === null) return show(held);
  held = current;
  try {
    return `${held.kind} ${show(held.operand)}`;
  } catch (e) {
    return `${held.kind} caught ${(e as Error).name}`;
  }
}

class Holder {
  expr: Expr | null = null;
  replace(): void {
    this.expr = { kind: "lit", value: 9 };
  }
}

function fromProperty(replace: boolean): string {
  const h = new Holder();
  h.expr = { kind: "neg", operand: { kind: "lit", value: 3 } };
  if (replace) h.replace();
  if (h.expr === null) return "null";
  const held: Expr = h.expr;
  try {
    return `${held.kind} ${show(held.operand)}`;
  } catch (e) {
    return `${held.kind} caught ${(e as Error).name}`;
  }
}

for (const replace of [false, true]) {
  console.log("initializer:", fromInitializer(replace));
  console.log("assignment:", fromAssignment(replace));
  console.log("property:", fromProperty(replace));
}
