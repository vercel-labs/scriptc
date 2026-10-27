// The empty object type `{}` admits every non-nullish value, including when
// tsc infers it from an empty object literal: union subtype reduction folds
// primitives into it (`["12", {}]` is `{}[]`, `flag ? "x" : {}` is `{}`), and
// a `let` initialized with `{}` takes any later non-nullish value.
const flag = Math.random() < 2;

const mixed = ["12", {}];
console.log(mixed.length, typeof mixed[0], typeof mixed[1]);

const marker = {};
const list = [marker, "x", 3, true, [1]];
console.log(list.length, list[0] === marker, list.map((x) => typeof x).join(","));

const holder = { value: flag ? "x" : {} };
const picked = flag ? "y" : {};
console.log(typeof holder.value, typeof picked, holder.value, picked);

let slot = {};
console.log(JSON.stringify(slot));
slot = "now a string";
console.log(typeof slot, slot);
slot = 42;
console.log(typeof slot, slot);

function choose(n: number) {
  if (n > 0) return "positive";
  return {};
}
console.log(typeof choose(1), typeof choose(-1));

const empty = {};
console.log(JSON.stringify(empty), Object.keys(empty).length, empty === empty, String(empty));

// An empty literal's type beside a typed arm of an unreduced union, after
// the type was already used on its own.
const viewed = {};
console.log(JSON.stringify(viewed));
const views: (typeof viewed | DataView)[] = [viewed, new DataView(new ArrayBuffer(2))];
for (const view of views)
  console.log(view instanceof DataView ? `view ${view.byteLength}` : JSON.stringify(view));
