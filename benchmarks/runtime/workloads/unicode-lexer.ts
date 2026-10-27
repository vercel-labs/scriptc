// A lexer over a large bundled module whose comments and strings are in
// several languages: line starts, tokens by kind and comment text, read
// with charCodeAt as hand-written scanners do. Each pass relexes the whole
// text, as a bundler or an editor does after a change.
const comments = [
  "// Berechnet die Größe des Puffers für übergroße Einträge",
  "// Calcule la taille maximale avant la prochaine itération",
  "// バッファのサイズを計算します",
  "/* 计算缓冲区大小，然后返回结果 */",
  "// Returns the cached value (fast path) — see the note above",
  "/** Résumé: the état of the café's ñandú registry */",
];
const strings = ['"Grüße"', '"naïve façade"', '"東京"', '"ok ✓"', '"plain ascii"', "'mañana'"];
const names = ["buffer", "größe", "index", "resultat", "count", "value", "entry", "table"];

let seed = 11;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}
function pick(list: readonly string[]): string {
  return list[Math.floor(random() * list.length)]!;
}

function makeSource(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const r = random();
    if (r < 0.2) out.push(pick(comments));
    else if (r < 0.6) out.push(`  const ${pick(names)}${i} = ${pick(names)}(${Math.floor(random() * 1000)}, ${pick(strings)});`);
    else if (r < 0.85) out.push(`  if (${pick(names)} >= ${i % 97}) return ${pick(names)}.${pick(names)} + 1;`);
    else out.push(`function ${pick(names)}${i}(a, b) { return a * b - ${i}; }`);
  }
  return out.join("\n");
}

interface Counts {
  lines: number;
  identifiers: number;
  numbers: number;
  strings: number;
  comments: number;
  commentChars: number;
  punctuation: number;
}

function isIdentifierStart(ch: number): boolean {
  return (ch >= 97 && ch <= 122) || (ch >= 65 && ch <= 90) || ch === 95 || ch === 36 || ch > 127;
}

function isIdentifierPart(ch: number): boolean {
  return isIdentifierStart(ch) || (ch >= 48 && ch <= 57);
}

function lex(text: string): Counts {
  const counts: Counts = { lines: 1, identifiers: 0, numbers: 0, strings: 0, comments: 0, commentChars: 0, punctuation: 0 };
  let pos = 0;
  const end = text.length;
  while (pos < end) {
    const ch = text.charCodeAt(pos);
    if (ch === 10) {
      counts.lines++;
      pos++;
    } else if (ch === 32 || ch === 9 || ch === 13) {
      pos++;
    } else if (ch === 47 && text.charCodeAt(pos + 1) === 47) {
      const start = pos;
      while (pos < end && text.charCodeAt(pos) !== 10) pos++;
      counts.comments++;
      counts.commentChars += pos - start;
    } else if (ch === 47 && text.charCodeAt(pos + 1) === 42) {
      const start = pos;
      pos += 2;
      while (pos < end && !(text.charCodeAt(pos) === 42 && text.charCodeAt(pos + 1) === 47)) {
        if (text.charCodeAt(pos) === 10) counts.lines++;
        pos++;
      }
      pos += 2;
      counts.comments++;
      counts.commentChars += pos - start;
    } else if (ch === 34 || ch === 39) {
      pos++;
      while (pos < end && text.charCodeAt(pos) !== ch) pos++;
      pos++;
      counts.strings++;
    } else if (ch >= 48 && ch <= 57) {
      while (pos < end && text.charCodeAt(pos) >= 48 && text.charCodeAt(pos) <= 57) pos++;
      counts.numbers++;
    } else if (isIdentifierStart(ch)) {
      while (pos < end && isIdentifierPart(text.charCodeAt(pos))) pos++;
      counts.identifiers++;
    } else {
      counts.punctuation++;
      pos++;
    }
  }
  return counts;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let pos = 0; pos < text.length; pos++) if (text.charCodeAt(pos) === 10) starts.push(pos + 1);
  return starts;
}

const scale = Number(process.argv[2] ?? "1");
const source = makeSource(60000);
const passes = Math.round(6 * scale);
let last = lex(source);
let total = last.identifiers + lineStarts(source).length;
for (let i = 1; i < passes; i++) {
  last = lex(source);
  total += last.identifiers + lineStarts(source).length;
}
console.log("units", source.length, "passes", passes, "total", total);
console.log(JSON.stringify(last));
