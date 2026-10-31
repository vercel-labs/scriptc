// Destructured results of small literal producers: string slices, numbers
// and booleans, with evaluation order, unread fields, throws and every
// slice() and substring() bound kind.
let trace = "";
function mark<T>(tag: string, value: T): T {
  trace += tag;
  return value;
}

function split(text: string, at: number): [string, string] {
  return [text.slice(0, at), text.slice(at)];
}
function cut(text: string, from: number, to: number): [string, number, boolean] {
  return [text.substring(from, to), text.length, from > to];
}
function divmod(a: number, b: number): [number, number] {
  return [Math.floor(a / b), a % b];
}
function pair(text: string): { head: string; size: number } {
  return { size: mark("s", text.length), head: mark("h", text.slice(1, -1)) };
}

const bounds = [0, 1, 2, 3, -1, -2, -3, -10, 10, 0.5, -0.5, 1.9, -1.9, -0, NaN, Infinity, -Infinity];
const texts = ["", "a", "ab", "abcdef", "héllo", "東京ok", "a\u{1F600}b"];
let lengths = 0;
let units = 0;
for (const text of texts) {
  for (const at of bounds) {
    const [head, tail] = split(text, at);
    lengths = lengths * 7 + head.length * 3 + tail.length;
    lengths %= 1000000007;
    if (head.length > 0) units += head.charCodeAt(head.length - 1);
    if (tail.length > 0) units += tail.charCodeAt(0);
    for (const to of bounds) {
      const [part, size, swapped] = cut(text, at, to);
      lengths = (lengths * 5 + part.length + size + (swapped ? 1 : 0)) % 1000000007;
    }
  }
}
console.log("lengths", lengths, "units", units);

// The pieces themselves, as strings.
const [left, right] = split("scriptc", 3);
console.log(left, right, `${left}|${right}`);

// Arguments, then fields in the literal's order, then the bindings.
trace = "";
const { head, size } = pair(mark("a", "[inner]"));
console.log("order", trace, head.length, size);

// Unread fields still run.
trace = "";
const [onlyHead] = split(mark("x", "unread"), mark("y", 2));
const { size: onlySize } = pair("<>");
console.log("unread", trace, onlyHead, onlySize);

// A mutable destructured binding.
let [first, rest] = split("mutable", 1);
first += "!";
console.log("let", first, rest.length);

// Numbers and a throw from an argument.
let sum = 0;
for (let i = 0; i < 50; i++) {
  const [q, r] = divmod(i * 31, 17);
  sum += q * 3 + r;
}
console.log("divmod", sum);
const list: (string | undefined)[] = ["xy", undefined];
for (const item of list) {
  try {
    const [a, b] = split(item!, 1);
    console.log("ok", a.length, b.length);
  } catch (error) {
    console.log("threw", error instanceof TypeError);
  }
}

// The producer keeps working for every other caller.
const whole = split("kept", 2);
console.log("kept", whole[0], whole[1], whole.length);

// Fields that write a parameter: each inlined call writes its own copy.
function bump(a: number, s: string): [number, number, string] {
  return [a++, (a = a * 2), s.slice(a - 3)];
}
for (const start of [2, 3]) {
  const [before, doubled, tailOf] = bump(start, "abcdefgh");
  console.log("writes", start, before, doubled, tailOf);
}
