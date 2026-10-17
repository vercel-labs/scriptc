// Slices read only by comparisons, numeric parsers, collection probes,
// switch discriminants and lent helper parameters, including the keys a
// map or set keeps after the slice that produced them is gone.
const ascii = "GET /api/users?id=42 200 17.5ms";
const mixed = "Aé水x😀yz-12.5e1 ok";
const bounds = [-Infinity, -40, -8, -2.5, -1, -0.5, -0, 0, 0.5, 1, 2, 3, 4.9, 5, 7, 10, 40, Infinity, NaN];

function compare(source: string, start: number, end: number): string {
  const s = source.slice(start, end);
  const t = source.substring(start, end);
  const parts = [
    String(s === "GET"),
    String(t === "GET"),
    String(source.slice(start, end) === source.substring(start, end)),
    String(source.slice(start, end) < "M"),
    String(source.substring(start, end) >= "a"),
    String(s.length),
    String(t.length),
    String(s.charCodeAt(0)),
    String(t.charCodeAt(t.length - 1)),
    String(s.indexOf("a")),
    String(t.includes("😀")),
    String(s.startsWith("A")),
    String(t.endsWith("z")),
  ];
  return parts.join(",");
}
for (const source of [ascii, mixed]) {
  for (const start of bounds) {
    const row: string[] = [];
    for (const end of bounds) row.push(compare(source, start, end));
    console.log(row.join(" | "));
  }
}

// Numeric parsing of slices.
const numbers = "  42|-0|0x1F|1e3|.5|Infinity|-Infinity|12px|abc|+7.25|  9  |0b11|1_000|";
let offset = 0;
while (offset < numbers.length) {
  const bar = numbers.indexOf("|", offset);
  const field = numbers.slice(offset, bar);
  console.log(
    JSON.stringify(field),
    Number(field),
    +numbers.substring(offset, bar),
    parseInt(field),
    parseInt(numbers.slice(offset, bar), 16),
    parseFloat(field),
    Object.is(Number(numbers.slice(offset, bar)), -0),
  );
  offset = bar + 1;
}
console.log(Number(mixed.slice(9, 16)), parseFloat(mixed.slice(9)), parseInt(mixed.slice(10, 12)));

// Collection probes and insertions keyed by slices. The stored keys must
// outlive every later slice written to the same site.
const counts = new Map<string, number>();
const seen = new Set<string>();
const words = "alpha beta gamma alpha delta beta alpha epsilon-with-a-much-longer-key-than-the-stack-buffer-holds-alpha zeta é-key é-key x x";
for (let round = 0; round < 3; round++) {
  let start = 0;
  while (start < words.length) {
    let end = words.indexOf(" ", start);
    if (end < 0) end = words.length;
    const word = words.slice(start, end);
    counts.set(word, (counts.get(word) ?? 0) + 1);
    if (!seen.has(word)) seen.add(word);
    if (counts.get(words.substring(start, end)) === 2) seen.delete(word);
    start = end + 1;
  }
}
console.log([...counts.entries()].map(([key, value]) => `${key}=${value}`).join(","));
console.log([...seen].join(","));
console.log(counts.has(ascii.slice(0, 3)), counts.has(words.slice(0, 5)), seen.has(words.slice(6, 10)));
const index = new Map<string, number>();
for (let i = 0; i + 3 <= ascii.length; i++) index.set(ascii.slice(i, i + 3), i);
console.log(index.size, index.get("api"), index.get(ascii.substring(5, 8)), [...index.keys()].slice(0, 6).join("/"));
const reads = new Map<string, string>([["api", "first"], ["users", "second"]]);
console.log(reads.get(ascii.slice(5, 8)), reads.get(ascii.slice(9, 14)) ?? "none", reads.get(ascii.slice(0, 1)) ?? "none");

// Switch discriminants.
function method(line: string): number {
  switch (line.slice(0, line.indexOf(" "))) {
    case "GET":
      return 1;
    case "POST":
      return 2;
    case "é":
      return 3;
    default:
      return 0;
  }
}
console.log(method(ascii), method("POST /x"), method("é y"), method("PATCH /x"), method("nospace"));

// Lent helper parameters, including recursion through a lent parameter.
function isKeyword(text: string): boolean {
  return text === "let" || text === "const" || text === "return";
}
function depth(text: string, n: number): number {
  if (n === 0) return text.length;
  return depth(text, n - 1) + (text === "abc" ? 1 : 0);
}
function keep(text: string): string[] {
  return [text];
}
const program = "let x = 1; const y = 2; return x + y; letter";
let keywords = 0;
const kept: string[][] = [];
for (let i = 0; i < program.length; i++) {
  for (let j = i + 2; j <= Math.min(program.length, i + 6); j++) {
    if (isKeyword(program.slice(i, j))) keywords++;
  }
  if (i % 9 === 0) kept.push(keep(program.slice(i, i + 4)));
}
console.log(keywords, depth("abcdef".slice(0, 3), 4), kept.map((k) => k[0]).join("|"));
