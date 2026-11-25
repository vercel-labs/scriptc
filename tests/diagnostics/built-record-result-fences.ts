// A generic function may return a record it built key by key as its
// declared result type (tests/corpus/9391-built-record-declared-result.ts):
// the object is this call's own, so the checked conversion the return
// applies cannot be told from Node's erased assertion. These neighbours
// keep the refusal: the record has another holder, so a copy would differ
// from the one object Node keeps, or the assertion names a type the
// instance has no result for.
type Keys<K extends string> = { [P in K]: string } & {};

// The record is the caller's.
function view<K extends string>(names: readonly K[], bag: Record<string, string>): Keys<K> {
  return bag as Keys<K>;
}

// The record is stored before the return.
let kept: Record<string, string> = {};
function stored<K extends string>(names: readonly K[]): Keys<K> {
  const out: Record<string, string> = {};
  for (const name of names) out[name] = name;
  kept = out;
  return out as Keys<K>;
}

// A closure holds the record.
function captured<K extends string>(names: readonly K[]): Keys<K> {
  const out: Record<string, string> = {};
  const add = (name: string): void => {
    out[name] = name;
  };
  for (const name of names) add(name);
  return out as Keys<K>;
}

// The record is passed to a call.
function passed<K extends string>(names: readonly K[]): Keys<K> {
  const out: Record<string, string> = {};
  for (const name of names) out[name] = name;
  console.log(Object.keys(out).length);
  return out as Keys<K>;
}

// A `finally` block writes the record after the return's value is taken.
function late<K extends string>(names: readonly K[]): Keys<K> {
  const out: Record<string, string> = {};
  try {
    for (const name of names) out[name] = name;
    return out as Keys<K>;
  } finally {
    out["late"] = "written after the return";
  }
}

// The same mapped type written out twice is two types.
function twice<K extends string>(names: readonly K[]): { [P in K]: string } {
  const out: Record<string, string> = {};
  for (const name of names) out[name] = name;
  return out as { [P in K]: string };
}

// The assertion is not the returned expression.
function local<K extends string>(names: readonly K[]): Keys<K> {
  const out: Record<string, string> = {};
  for (const name of names) out[name] = name;
  const typed = out as Keys<K>;
  return typed;
}

const names = ["b", "a"] as const;
console.log(view(names, { a: "A", b: "B" }).a);
console.log(stored(names).a, kept["a"]);
console.log(captured(names).a);
console.log(passed(names).a);
console.log(late(names).a);
console.log(twice(names).a);
console.log(local(names).a);
