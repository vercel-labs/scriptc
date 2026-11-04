// `for (let [a, b] = xs; ...)` / `for (const { p } = o; ...)`: a pattern
// declarator in a plain for-loop initializer lowers to the same flat
// statement list an identifier declarator does, so the loop head's
// per-iteration copy sees the pattern's bindings. A captured binding
// answers the iteration its closure was created in, and a write in the
// body reaches the next iteration's copy — exactly `for (let i = ...)`.

// Captured bindings, a body write, and the pattern's own default.
const closers: Array<() => string> = [];
for (let [i, tag = "t"] = [0]; i < 3; i++) {
  closers.push(() => `${i}${tag}`);
  tag += "!";
}
console.log(closers.map((f) => f()).join(","));

// Several declarators in one head: the pattern's bindings and a plain
// identifier share the per-iteration copy, and the second declarator's
// initializer reads the first one's binding.
const seen: string[] = [];
for (let [first, second = "S"] = ["a"], third = second + "!"; seen.length < 2; third += "+") {
  seen.push(`${first}${second}${third}`);
}
console.log(seen.join(","));

// A `const` pattern head: the binding is never reassigned, so every
// closure shares it.
const shared: Array<() => string> = [];
for (const { p, q = "Q" } = { p: "P" }; shared.length < 2; ) shared.push(() => p + q);
console.log(shared.map((f) => f()).join(","));

// A body write to a pattern binding is carried into the next iteration's
// copy, and the head's own initializer runs once.
const counts: number[] = [];
for (let [n = 0] = [] as number[]; n < 4; n++) counts.push(n);
console.log(counts.join(","));

// A source that carries a nested record and a tuple position.
interface Pair {
  readonly left: { readonly name: string };
  readonly right: readonly [number, number];
}
const pairs: string[] = [];
for (let { left: { name }, right: [a] } = { left: { name: "n" }, right: [1, 2] } as Pair; pairs.length < 2; ) {
  pairs.push(`${name}:${a}`);
}
console.log(pairs.join(","));

// A pattern head inside a nested block, and one in a `for` that never
// runs its body: the head still initializes once.
{
  for (let [x] = [7]; false; ) console.log("never", x);
  console.log("nested ok");
}
console.log("done");
