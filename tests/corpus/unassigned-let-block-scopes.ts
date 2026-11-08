// A `let` declared without an initializer inside a loop body is a fresh
// binding on every pass, undefined again until that pass assigns it.

const seen: string[] = [];
for (let i = 0; i < 3; i++) {
  let v: number;
  const peek = (): string => typeof v + ":" + v;
  seen.push(peek());
  v = i * 10;
  seen.push(peek());
}
console.log(seen.join(" "));

function names(): string {
  const out: string[] = [];
  for (const k of ["a", "b"]) {
    let s: string;
    const get = (): string => s ?? "unset";
    out.push(get());
    s = k;
    out.push(get());
  }
  return out.join(",");
}
console.log(names());

// Closures of different passes keep their own binding.
function perPass(): string {
  const readers: (() => string)[] = [];
  let pass = 0;
  while (pass < 3) {
    let item: { n: number };
    readers.push(() => (item === undefined ? "none" : String(item.n)));
    if (pass !== 1) item = { n: pass };
    pass++;
  }
  return readers.map((r) => r()).join(",");
}
console.log(perPass());

// Declared in the head of a `for` statement.
function forHead(): string {
  const out: string[] = [];
  for (let first: string, i = 0; i < 2; i++) {
    const read = (): string => first ?? "unset";
    out.push(read());
    first = "set" + i;
    out.push(read());
  }
  return out.join(",");
}
console.log(forHead());

// A nested block and a switch clause.
function nested(kind: number): string {
  {
    let inner: string[];
    const size = (): number => (inner === undefined ? -1 : inner.length);
    const before = size();
    inner = ["x"];
    switch (kind) {
      case 1: {
        let scratch: number;
        const read = (): string => typeof scratch;
        const early = read();
        scratch = 1;
        return [before, size(), early, read()].join("/");
      }
      default:
        return [before, size()].join("/");
    }
  }
}
console.log(nested(1), nested(2));

// Assigned on every path before the closure is made: read as declared.
function settled(n: number): string {
  let kind: string;
  if (n > 0) kind = "positive";
  else if (n < 0) kind = "negative";
  else kind = "zero";
  let parsed: number;
  try {
    parsed = JSON.parse(String(n)) as number;
  } catch {
    return "unparsed";
  }
  const show = (): string => kind + ":" + parsed;
  return show();
}
console.log(settled(2), settled(-1), settled(0));
