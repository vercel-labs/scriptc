// A generic `function` DECLARATION inside another function compiles through
// the function-scoped generic machinery a generic arrow binding uses: each
// call site's signature instantiates one module function, and the enclosing
// frame's values travel as trailing parameters — or through a closure
// environment when the frame reassigns one. A declaration is hoisted, so a
// call may run before its statement, and a nested generic may recurse.
interface Pending {
  resolve: (value: unknown) => void;
}

// pi's rpc-mode shape: the nested helper captures a Map and a counter the
// enclosing frame reassigns, and is called at two types.
function host(): { pick: () => Promise<string | undefined>; ok: () => Promise<boolean> } {
  const pending = new Map<string, Pending>();
  let next = 0;
  function ask<T>(fallback: T, parse: (raw: string) => T): Promise<T> {
    const id = `r${next++}`;
    return new Promise<T>((resolve) => {
      pending.set(id, { resolve: (raw) => resolve(typeof raw === "string" ? parse(raw) : fallback) });
    });
  }
  const answer = (id: string, raw: unknown): void => {
    pending.get(id)?.resolve(raw);
    pending.delete(id);
  };
  setTimeout(() => {
    answer("r0", "chosen");
    answer("r1", 42);
  }, 0);
  return {
    pick: () => ask<string | undefined>(undefined, (raw) => raw),
    ok: () => ask(false, (raw) => raw === "yes"),
  };
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

const h = host();
const picked = h.pick();
const ok = h.ok();
Promise.all([picked, ok]).then(([value, flag]) => {
  console.log(value, flag, typeof value, typeof flag);
  console.log(hoisted("h"));
  console.log(recursion());
  console.log(siblings());
  console.log(arity());
});
