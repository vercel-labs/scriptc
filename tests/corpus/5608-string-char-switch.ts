// switch on one character of a string with one-unit case literals: the
// index and charAt forms, indexes out of range, negative, fractional and
// NaN, astral text and lone surrogates, duplicate cases, fallthrough, a
// switch without default, few and many cases, and an index expression
// with a side effect.
function classify(ch: string): string {
  return ch;
}
function kind(s: string, i: number): string {
  switch (s[i]) {
    case "(":
    case ")":
      return "paren";
    case "{":
      return "brace";
    case "é":
      return "e-acute";
    case "\uD83D":
      return "high";
    case "\uDE00":
      return "low";
    case "\uD800":
      return "lone";
    case "(":
      return "duplicate";
    case " ":
      return "space";
    default:
      return "other";
  }
}
function few(s: string, i: number): number {
  let n = 0;
  switch (s.charAt(i)) {
    case "a":
      n += 1;
    case "b":
      n += 2;
      break;
    case "c":
      n += 4;
  }
  return n;
}
const samples = ["(x) {é}", "😀", "\uD800", "", "abc", " "];
const indexes = [0, 1, 2, 3, -1, 0.5, NaN, 100];
for (const s of samples) {
  console.log(
    JSON.stringify(s),
    indexes.map((i) => kind(s, i)).join(","),
    indexes.map((i) => few(s, i)).join(","),
  );
}
let calls = 0;
const text = "abc";
const next = (): number => calls++;
for (let r = 0; r < 4; r++) {
  switch (text.charAt(next())) {
    case "a":
      console.log("a", calls);
      break;
    case "c":
      console.log("c", calls);
      break;
    default:
      console.log("default", calls);
  }
}
function tokens(text: string): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    switch (text[i]) {
      case "(":
      case ")":
        out.push("p");
        break;
      case "+":
      case "-":
      case "*":
      case "/":
        out.push("o");
        break;
      case "\uD83D":
        out.push("h");
        break;
      case " ":
        break;
      default:
        out.push(text[i]);
    }
  }
  return out.join("");
}
console.log(tokens("(a + b) * c / d - é"), tokens("x😀y"), tokens(""));
console.log(classify("ok"));
