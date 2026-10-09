// lastIndex-driven exec/test loops over one long subject reuse its decoded
// form between calls (the runtime used to rescan or re-convert the whole
// subject per call, so these loops were quadratic). Pins match indices,
// lastIndex, and captures for ASCII and non-ASCII subjects, alternating
// subjects, nested regex use inside the loop, and strings rebuilt after
// being matched.
const parts: string[] = [];
for (let i = 0; i < 60000; i++) parts.push("k" + i + "=v" + (i % 97));
const ascii = parts.join("&");

const pair = /(\w+)=(\w+)/g;
let m: RegExpExecArray | null;
let count = 0;
let sum = 0;
let lastIndexSum = 0;
while ((m = pair.exec(ascii)) !== null) {
  count++;
  sum += m[2]!.length + m.index;
  lastIndexSum += pair.lastIndex;
}
console.log(count, sum, lastIndexSum, pair.lastIndex);

// Non-ASCII subject: indices are UTF-16 code units (an astral character
// counts twice), and captures decode back to the original text.
const wideParts: string[] = [];
for (let i = 0; i < 20000; i++) wideParts.push(i % 5 === 0 ? "é" + i + "😀" : "w" + i);
const wide = wideParts.join(" ");
const word = /([^\s]+)/g;
let wideCount = 0;
let wideIndex = 0;
let emoji = 0;
while ((m = word.exec(wide)) !== null) {
  wideCount++;
  wideIndex = m.index;
  if (m[1]!.endsWith("😀")) emoji++;
}
console.log(wideCount, wideIndex, emoji, wide.length);

// Global test() walks the same subject via lastIndex.
const digit = /\d+/g;
let tests = 0;
while (digit.test(ascii)) tests++;
console.log(tests, digit.lastIndex);

// Sticky tokenizer over a long input.
const src = "abc 123 ".repeat(5000) + "end";
const tok = /([a-z]+)|(\d+)|(\s+)/y;
let idents = 0;
let nums = 0;
let spaces = 0;
let tm: RegExpExecArray | null;
while ((tm = tok.exec(src)) !== null) {
  if (tm[1] !== undefined) idents++;
  else if (tm[2] !== undefined) nums++;
  else spaces++;
}
console.log(idents, nums, spaces, tok.lastIndex);

// Alternating subjects with one regex and with two regexes.
const left = "x1 ".repeat(400);
const right = "é2 ".repeat(400);
const a = /\d/g;
const b = /\d/g;
let alt = "";
for (let i = 0; i < 3; i++) {
  const ma = a.exec(left);
  const mb = b.exec(right);
  alt += `${ma!.index}:${a.lastIndex}/${mb!.index}:${b.lastIndex} `;
}
const shared = /\d/g;
const s1 = shared.exec(left)!.index;
const s2 = shared.exec(right)!.index; // lastIndex 2 carries over to the other subject
console.log(alt.trim(), s1, s2, shared.lastIndex);

// A nested regex over another long subject inside the loop.
const outer = /k(\d+)=/g;
let nested = 0;
let seen = 0;
while ((m = outer.exec(ascii)) !== null && seen < 2000) {
  seen++;
  if (/é(\d+)😀/.exec(wide)!.index === 0) nested++;
}
console.log(seen, nested, outer.lastIndex);

// A string rebuilt after it was matched is matched fresh.
let grow = "q0".repeat(200);
const q = /q(\d)/g;
q.exec(grow);
grow += "q7";
q.lastIndex = grow.length - 2;
const tail = q.exec(grow);
console.log(tail![1], tail!.index, grow.length);

// replace() with a callback that runs exec on another long subject.
const replaced = left.replace(/x(\d)/g, (_m, d: string) => {
  const inner = /é(\d)/g;
  inner.lastIndex = 3;
  return inner.exec(right)![1]! + d;
});
console.log(replaced.slice(0, 12), replaced.length);
