// Indexing a string whose binding was read from an array or narrowed from a
// union with typeof. The receiver's stored value keeps its other arms, so an
// out-of-bounds array read throws Node's TypeError at the index, naming the
// key.
interface Key {
  name: string;
}
type Token = string | Key;

// path-to-regexp's tokensToRegexp shape.
function endDelimited(tokens: Token[], delimiters: string): boolean {
  const endToken = tokens[tokens.length - 1];
  return typeof endToken === "string"
    ? delimiters.indexOf(endToken[endToken.length - 1]) > -1
    : endToken === undefined;
}
console.log(
  endDelimited(["a/", { name: "x" }], "/"),
  endDelimited(["a/"], "/"),
  endDelimited([], "/"),
  endDelimited(["ab"], "/"),
);

function lastChar(tokens: Token[]): string {
  const t = tokens[0];
  if (typeof t === "string") return t[t.length - 1];
  return "-";
}
console.log(lastChar(["xyz"]), lastChar([{ name: "k" }]));

function lastLetter(words: string[], i: number): string {
  const w = words[i];
  return w[w.length - 1];
}
console.log(lastLetter(["ab", "cd"], 1));

function at(words: string[], i: number, j: number): string | undefined {
  const w = words[i];
  return w[j];
}
console.log(at(["abc"], 0, 1), at(["abc"], 0, 7), at(["abc"], 0, 1.5), at(["abc"], 0, -1));
for (const j of [2, -0.5, 1e21]) {
  try {
    at(["abc"], 3, j);
  } catch (e) {
    console.log(e instanceof TypeError, (e as Error).message);
  }
}

let calls = 0;
function key(): number {
  calls++;
  return 0;
}
function viaCall(words: string[]): string {
  const w = words[0];
  return w[key()];
}
console.log(viaCall(["q"]), calls);
