// `left ?? right` where the right side's type is wider than the left's
// present value: an array of one record type defaulted to an array of a
// union that includes it, and the same for numbers and single records.
interface Word {
  kind: "word";
  text: string;
}
interface Num {
  kind: "num";
  value: number;
}
type Token = Word | Num;

function render(tokens: Token[]): string {
  return tokens.map((token) => (token.kind === "num" ? `#${token.value}` : token.text)).join(" ");
}

const line: Token[] = [
  { kind: "word", text: "take" },
  { kind: "num", value: 3 },
  { kind: "word", text: "eggs" },
];
const wordsOnly: Word[] = [
  { kind: "word", text: "take" },
  { kind: "word", text: "eggs" },
];

// A map lookup: the narrower list when one was cached, the whole line otherwise.
const cache = new Map<string, Word[]>([["words", wordsOnly]]);
console.log(render(cache.get("words") ?? line));
console.log(render(cache.get("digits") ?? line));

// An optional member of a record.
interface Scan {
  words?: Word[];
}
function shown(scan: Scan): string {
  return render(scan.words ?? line);
}
console.log(shown({ words: [wordsOnly[1]!] }), "/", shown({}));

// Element types that are primitives, a single record, and a left side that may also be null.
function widths(known: number[] | undefined, rough: (number | string)[]): string {
  return (known ?? rough).join(":");
}
function head(word: Word | undefined, token: Token): string {
  const first = word ?? token;
  return first.kind === "word" ? first.text : String(first.value);
}
function size(words: Word[] | null | undefined, tokens: Token[]): number {
  const chosen = words ?? tokens;
  return chosen.length;
}
console.log(widths([4, 4], ["wide", 2]), widths(undefined, ["wide", 2]));
console.log(head(wordsOnly[0], line[1]!), head(undefined, line[1]!));
console.log(size(wordsOnly, line), size(null, line), size(undefined, line));

// The right side runs only when the left is missing, and the left runs once.
const ran: string[] = [];
function cached(key: string): Word[] | undefined {
  ran.push(`left(${key})`);
  return cache.get(key);
}
function whole(): Token[] {
  ran.push("right");
  return line;
}
console.log((cached("words") ?? whole()).length, (cached("digits") ?? whole()).length, ran.join(" "));
