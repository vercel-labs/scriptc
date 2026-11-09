// A `const` that decides a condition, read before its declaration has run: the
// condition still evaluates, so each form throws Node's ReferenceError until
// the declaration runs, and afterwards only the selected code runs. The forms
// are the `if` statement, `!`, the right operand of `&&` and `||`, the
// conditional expression, a `const` derived from another, and a selected arm
// that leaves a loop or assigns a variable declared without a value.
export {};

function report(e: unknown): void {
  console.log((e as Error).name + ": " + (e as Error).message);
}

function ran(label: string): boolean {
  console.log("ran " + label);
  return true;
}

const held: unknown = { count: 1 };

function viaIf(): string {
  if (LATE) {
    Object.freeze(held);
    return "then";
  } else {
    return "else";
  }
}

function viaNot(): string {
  if (!LATE) {
    return "then";
  }
  Object.seal(held);
  return "after";
}

function viaAnd(): string {
  return String(LATE && ran("and"));
}

function viaOr(): string {
  return String(!LATE || ran("or"));
}

function viaConditional(): string {
  return LATE ? "then" : "else";
}

function viaConditionalValue(): string {
  const picked = LATE ? Object.preventExtensions(held) : 7;
  const label: string | number = !LATE ? "text" : 0;
  return typeof picked + " " + typeof label + " " + label;
}

function viaDerived(): string {
  if (DERIVED) {
    ran("derived");
    return "then";
  }
  return DERIVED ? "selected" : "after";
}

function viaLoop(): string {
  const seen: number[] = [];
  let last: number;
  for (let i = 0; i < 6; i++) {
    if (!LATE) {
      if (i === 1) continue;
      if (i === 4) break;
    } else {
      seen.push(-1);
    }
    seen.push(i);
  }
  if (LATE) {
    last = -1;
  } else {
    last = seen.length;
  }
  return seen.join(",") + " " + last;
}

const probes = [
  viaIf,
  viaNot,
  viaAnd,
  viaOr,
  viaConditional,
  viaConditionalValue,
  viaDerived,
  viaLoop,
];

function probe(stage: string): void {
  console.log(stage);
  for (const each of probes) {
    try {
      console.log(each());
    } catch (e) {
      report(e);
    }
  }
}

probe("before LATE");

const LATE = false;

probe("before DERIVED");

const DERIVED = !LATE && LATE;

probe("after both");
console.log(Object.isFrozen(held), Object.isSealed(held), Object.isExtensible(held));
