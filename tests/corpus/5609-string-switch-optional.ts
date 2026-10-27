// switch on a string | undefined value with string literal cases: array
// reads, optional fields and Map lookups that may be undefined, matching
// and missing values, the empty string, non-ASCII and long literals,
// duplicate cases, fallthrough, default in the middle, and few cases.
interface Token {
  text?: string;
}
function kind(t: string | undefined): string {
  switch (t) {
    case "function":
    case "class":
      return "decl";
    case "":
      return "empty";
    case "naïve":
      return "unicode";
    case "a-much-longer-keyword-than-eight-bytes":
      return "long";
    case "function":
      return "duplicate";
    default:
      return t === undefined ? "missing" : "other";
    case "return":
      return "flow";
  }
}
function fallthrough(t: string | undefined): number {
  let n = 0;
  switch (t) {
    case "a":
      n += 1;
    case "b":
      n += 2;
      break;
    default:
      n += 8;
    case "c":
      n += 4;
  }
  return n;
}
function few(t: string | undefined): string {
  switch (t) {
    case "x":
      return "x";
  }
  return "none";
}
const words = ["function", "class", "", "naïve", "a-much-longer-keyword-than-eight-bytes", "return", "other", "Function"];
for (let i = 0; i <= words.length; i++) {
  const w: string | undefined = words[i];
  console.log(i, kind(w), fallthrough(w), few(w));
}
const tokens: Token[] = [{ text: "a" }, {}, { text: "c" }, { text: "x" }];
console.log(tokens.map((t) => `${kind(t.text)}:${fallthrough(t.text)}:${few(t.text)}`).join(" "));
const table = new Map<string, string>([["k", "return"], ["e", ""]]);
console.log(["k", "e", "z"].map((key) => kind(table.get(key))).join(" "));
