// String replace/replaceAll with typed function replacers. Callbacks whose
// every parameter receives its declared kind in each match (the match, the
// captures every match sets, the offset, the subject) are called through
// the closure directly; the rest keep the generic path. Both must match
// Node: all matches are collected before the first call, calls run in
// order with the offset in UTF-16 code units, and a throw stops the
// replacement.
const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (c) => entities[c] ?? c);
console.log(escapeHtml('a <b> & "c"'), escapeHtml("plain"));
console.log("hello world".replace(/o/, (m) => m.toUpperCase()));
console.log("hello world".replaceAll(/o/g, (m) => `[${m}]`));
console.log("abc".replace(/x/g, () => "never"));

console.log("a-b-c".replace(/-/g, (m: string, offset: number) => `${m}${offset}`));
console.log("ab".replace(/b/, (m: string, offset: number, input: string) => `${m}@${offset}/${input}`));
console.log("id-12 id-345".replace(/(\d+)/g, (_m: string, digits: string) => String(Number(digits) * 2)));
console.log("k1=v1;k2=v2".replace(/(\w+)=(\w+)/g, (_m: string, k: string, v: string) => `${v}=${k}`));
console.log("x1y22".replace(/(\d)+/g, (m: string, last: string, at: number) => `<${m}:${last}:${at}>`));
console.log("a=1".replace(/(\w)=(\d)/, (m: string, k: string, v: string, at: number) => `${m}|${k}|${v}|${at}`));
console.log("ab ab".replace(/(?<first>a)(b)/g, (m: string, a: string, b: string, at: number, all: string) => `${b}${a}${at}${all.length}`));

// Offsets count UTF-16 code units; empty matches advance by code points under /u.
console.log("héllo wörld 😀!".replace(/o/g, (m: string, at: number) => `${m}${at}`));
console.log("😀a".replace(/(?:)/gu, (m: string, at: number) => `[${at}]`));
console.log("😀a".replace(/(?:)/g, (m: string, at: number) => `[${at}]`));

// Captures that some match leaves unset keep the generic path.
console.log("ab".replace(/(a)|(b)/g, (m: string, a?: string, b?: string) => `${m}:${a}:${b};`));
console.log("ab".replace(/(x)?b/, (m: string, x?: string) => `${m}:${x}`));
const dynamicPattern = /(\d)/g;
console.log("1-2".replace(dynamicPattern, (m: string, d: string) => d + d));

// The callback runs after every match is collected: it can reuse the regex.
const word = /\w+/g;
console.log("one two three".replace(word, (m: string) => `${m.length}${word.lastIndex}`), word.lastIndex);
const sticky = /a/y;
sticky.lastIndex = 1;
console.log("baaa".replace(sticky, (m: string) => m.toUpperCase()), sticky.lastIndex);

let calls = 0;
try {
  "a1b2c3".replace(/\d/g, (m: string) => {
    calls++;
    if (m === "2") throw new Error("stop at " + m);
    return "#";
  });
} catch (error) {
  console.log((error as Error).message, calls);
}
try {
  "a1b2".replace(/(\d)|z/g, (m: string, d?: string) => {
    if (d === "2") throw new Error("generic stop at " + d);
    return "#" + m;
  });
} catch (error) {
  console.log((error as Error).message);
}
try {
  "aaa".replaceAll(/a/, (m: string) => m);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}

let total = 0;
for (let i = 0; i < 3000; i++) total += escapeHtml(`<${i}> & "${i}"`).length;
console.log(total);
