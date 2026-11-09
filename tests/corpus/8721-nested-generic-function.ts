// A generic `function` DECLARATION inside another function compiles through
// the function-scoped generic machinery a generic arrow binding uses: each
// call site's signature instantiates one module function, and the enclosing
// frame's values travel as trailing parameters — or through a closure
// environment when the frame reassigns one. A declaration is hoisted, so a
// call may run before its statement, and a nested generic may recurse.

// The enclosing frame reassigns a value the nested generic captures, so the
// captures travel through a closure environment. The declaration is called
// at three types and sees every write the frame makes between the calls.
function shelve(): string {
  const labels = new Map<number, string>();
  let issued = 0;
  function file<T>(item: T, describe: (item: T) => string): number {
    issued += 1;
    labels.set(issued, describe(item));
    return issued;
  }
  const year = file(1984, (value) => `year ${value}`);
  const authors = file(["Le Guin", "Lem"], (names) => names.join(" & "));
  issued += 10;
  const lending = file(false, (reference) => (reference ? "reference" : "lending"));
  const filed = [...labels].map(([slot, label]) => `${slot}=${label}`).join(", ");
  return `${year} ${authors} ${lending} ${issued} ${filed}`;
}

// Trailing-parameter captures (nothing the frame writes), and the first call
// runs before the declaration statement: the hoisted function reads the
// frame at the call.
function hoisted(prefix: string): string {
  const first = show(1);
  function show<T>(value: T): string {
    return `${prefix}:${typeof value}:${String(value)}`;
  }
  return `${first} ${show("two")} ${show(true)}`;
}

// A nested generic recursing at one type, over a captured counter.
function recursion(): string {
  let calls = 0;
  function depth<T>(items: T[], index: number): number {
    calls++;
    return index >= items.length ? 0 : 1 + depth(items, index + 1);
  }
  return `${depth([1, 2, 3], 0)} ${calls}`;
}

// A sibling ordinary nested function calling the generic, and a call from a
// closure created before the declaration.
function siblings(): string {
  const early = (): string => twice("x").join("");
  function twice<T>(value: T): [T, T] {
    return [value, value];
  }
  function useBoth(): string {
    const [a, b] = twice("y");
    return `${a}${b}${twice(7)[1]}`;
  }
  return `${early()} ${useBoth()}`;
}

// The declaration's own `arguments` object is the instance's: a capture
// travels as a trailing parameter, yet `arguments.length` still reports the
// call's count, as in JavaScript.
function arity(): string {
  const base = 10;
  function counted<T>(value: T): string {
    return `${arguments.length}:${String(value)}:${base}`;
  }
  return counted(7);
}

console.log(shelve());
console.log(hoisted("h"));
console.log(recursion());
console.log(siblings());
console.log(arity());
