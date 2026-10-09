// console.log/console.error whose arguments are string concatenations
// (template literals, `+` chains). The compiler passes the parts to the
// runtime instead of the joined string; output must equal printing the
// joined string: String() number spelling inside the text (-0 is "0", unlike
// a bare -0 argument), no extra spaces between parts, one space between
// arguments, source-order evaluation, and stable string lifetimes.
const negZero = -0;
const values = [0, negZero, 1, -1, 0.5, 1e21, 1e-7, 2 ** 53, NaN, Infinity, -Infinity, 123.456];
for (const v of values) {
  console.log(`v=${v}`, v, "" + v);
  console.error(`[${v}]` + "|" + v);
}

const flag = values.length > 3;
console.log(`flag ${flag} ${!flag}`, flag);
console.log("plain " + 1 + 2, 1 + 2 + " sum");
console.log(`${""}${""}`, `${"a"}${""}${"b"}`, "", `x`);
console.log(`unicode caf\u00e9 ${"\u{1f9e8}"} ${values.length}\u2014ok`);

// More than sixteen parts: the tail stays a grouped concatenation.
const n = 7;
console.log(
  `${n}a${n}b${n}c${n}d${n}e${n}f${n}g${n}h${n}i${n}j${n}k${n}l${n}m${n}n${n}o${n}p${n}q${n}r${n}`,
);

// Parts evaluate in source order, once each.
let calls = "";
function tick(label: string, value: number): number {
  calls += label;
  return value;
}
console.log(`${tick("a", 1)}-${tick("b", 2)}`, tick("c", 3), `${tick("d", 4)}`);
console.log(calls);

// A later part reassigns a string used by an earlier part.
let s = "first-" + String(n);
function reassign(): string {
  s = "second-" + String(n);
  return "r";
}
console.log(`${s}:${reassign()}:${s}`);
console.error(`${s}/${(s = "third")}/${s}`);

// Optional and union-typed values inside templates.
const maybe: string | undefined = n > 100 ? "never" : undefined;
const either: string | number = n > 3 ? n * 2 : "small";
console.log(`maybe=${maybe} either=${either}`, maybe === undefined);

// Inside functions, loops, and async code.
function line(id: number, ok: boolean): void {
  if (ok) console.log(`#${id} ok latency=${id * 1.5}ms`);
  else console.error("#" + id + " failed after " + id * 0.25 + "s", id);
}
for (let i = 0; i < 4; i++) line(i, i % 2 === 0);

async function later(): Promise<void> {
  await Promise.resolve();
  console.log(`async ${values.length} ${negZero}`, negZero);
}
later();
