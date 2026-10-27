// Array destructuring of a value whose type is a union of array and tuple
// types: a regex match or a default row (`re.exec(s) || ["", "", ""]`), and
// functions answering either a fixed tuple or a list. Each position reads
// the arm the value holds; positions past a tuple's end and past an array's
// end read undefined, and defaults fire exactly there.
function scan(text: string): string {
  const [match, head, word] = /(\w*)-(\w+)/.exec(text) || ["", "", ""];
  return `${match}|${head}|${word.toUpperCase()}`;
}
console.log(scan("ab-cd"), scan("none"), scan("-x"));

function pick(flag: boolean): [string, number] | string[] {
  return flag ? ["a", 1] : ["b", "c"];
}
const [p, q] = pick(true);
const [r, s = "dflt", t = "z"] = pick(false);
const [u, , w = "w"] = pick(true);
console.log(p, q, r, s, t, u, w);
console.log(typeof q, typeof s);

function pair(n: number): number[] | [number, number] {
  return n > 1 ? [n, n * 2] : [n];
}
const [x, y] = pair(7);
const [x1, y1 = -1] = pair(1);
console.log(x, y, x1, y1);

function row(kind: string): [string, boolean] | [string, boolean, number] {
  return kind === "long" ? [kind, true, 3] : [kind, false];
}
for (const k of ["long", "short"]) {
  const [name, flag, count = 0] = row(k);
  console.log(name, flag, count);
}

// A match or an empty string (`re.exec(s) || ""`): a string destructures
// by code point, so the empty string binds undefined.
function firstHit(text: string): string {
  const [hit] = /\d+/.exec(text) || "";
  return hit ? `hit ${hit}` : "none";
}
console.log(firstHit("ab12"), firstHit("ab"));
