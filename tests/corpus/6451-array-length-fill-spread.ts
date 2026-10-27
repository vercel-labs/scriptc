// Array(n).fill(v): the checker types the length-constructed array as
// any[], but fill gives every element v's type, so the array (and an
// array literal spreading it) holds strings.
function expand(head: string, tail: string): number[] | null {
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const all = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  if (all.length !== 8) return null;
  return all.map((part) => Number.parseInt(part || "0", 16));
}
console.log(JSON.stringify(expand("2001:db8", "1")), JSON.stringify(expand("fe80", "")));
const pad: string[] = Array(3).fill("-");
console.log(pad.join(""), [..."ab", ...new Array(2).fill("c")].join(""));
