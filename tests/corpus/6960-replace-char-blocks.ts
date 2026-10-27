// Chains of global one-character replacements over subjects of every
// length up to 70: matches at each position (block edges included), runs
// of matches, non-ASCII neighbors, empty and long replacements, chains of
// up to ten characters, and lone surrogates meeting at a seam.
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function strip(text: string): string {
  return text.replace(/a/g, "").replace(/e/g, "").replace(/i/g, "");
}
function widen(text: string): string {
  return text.replace(/x/g, "[a long replacement text that grows the result]").replace(/y/g, "é");
}
function many(text: string): string {
  return text
    .replace(/0/g, "zero")
    .replace(/1/g, "one")
    .replace(/2/g, "two")
    .replace(/3/g, "three")
    .replace(/4/g, "four")
    .replace(/5/g, "five")
    .replace(/6/g, "six")
    .replace(/7/g, "seven")
    .replace(/8/g, "eight")
    .replace(/9/g, "nine");
}

let total = 0;
let digest = 0;
function note(text: string): void {
  total += text.length;
  for (let i = 0; i < text.length; i++) digest = (digest * 31 + text.charCodeAt(i)) % 1000000007;
}
for (let length = 0; length <= 70; length++) {
  const base = "abcdefghij".repeat(8).slice(0, length);
  note(escapeHtml(base));
  note(strip(base));
  for (let at = 0; at < length; at++) {
    const marked = base.slice(0, at) + "&" + base.slice(at + 1);
    note(escapeHtml(marked));
    const pair = base.slice(0, at) + '<"' + base.slice(at + 2);
    note(escapeHtml(pair));
    note(widen(base.slice(0, at) + "x" + base.slice(at + 1)));
  }
  note(escapeHtml("&".repeat(length)));
  note(escapeHtml('<>"&'.repeat(length).slice(0, length)));
  note(many("0123456789".repeat(8).slice(0, length)));
  note(strip("aei".repeat(length)));
}
console.log(total, digest);

console.log(escapeHtml("héllo & wörld <ü> \"ç\" & 中文 <b>"));
console.log(escapeHtml("ünïcödé ".repeat(5) + "&<>\"" + " ñ".repeat(9)));
console.log(widen("xyxyxy"), widen("é x é y é"), strip("aeiaeiaei"), many("90210"));
console.log(escapeHtml("x".repeat(15) + "&" + "y".repeat(16) + "<" + "z".repeat(17) + ">"));

// A lone high surrogate before a replaced character and a lone low one in
// its replacement form a pair at the seam.
const high = "\uD83D";
const joined = (high + "&").replace(/&/g, "\uDE00");
console.log(joined.length, joined.codePointAt(0), joined === "😀");
const longJoined = ("abcdefghijklmnop" + high + "&qrstuvwxyz").replace(/&/g, "\uDE00");
console.log(longJoined.length, longJoined.codePointAt(16), longJoined.slice(16, 18) === "😀");
