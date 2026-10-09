// String element reads whose index is proven inside the string: counted
// loops in both directions, scanner loops guarded by `i < text.length`,
// early exits, length aliases, and helpers that take one character.
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}
function isLetter(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function tokens(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " ") {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(ch)) {
      while (i < text.length && isDigit(text[i])) i++;
      out.push(`num:${text.slice(start, i)}`);
    } else if (isLetter(ch)) {
      while (i < text.length && (isLetter(text[i]) || isDigit(text[i]))) i++;
      out.push(`word:${text.slice(start, i)}`);
    } else {
      out.push(`sym:${ch}`);
      i++;
    }
  }
  return out;
}

function reversed(text: string): string {
  let out = "";
  for (let i = text.length - 1; i >= 0; i--) out += text[i];
  return out;
}

function everyOther(text: string): string {
  let out = "";
  for (let i = 0; i <= text.length - 1; i += 2) out += text[i];
  return out;
}

function firstNonSpace(text: string): string {
  let i = 0;
  while (true) {
    if (i >= text.length) return "(none)";
    if (text[i] !== " ") return text[i];
    i++;
  }
}

function countOf(text: string, wanted: string): number {
  const n = text.length;
  let count = 0;
  for (let i = 0; i < n; i++) if (text[i] === wanted) count++;
  return count;
}

function trimRight(text: string): string {
  let end = text.length - 1;
  while (end >= 0 && text[end] === " ") end--;
  return text.slice(0, end + 1);
}

function middle(text: string): string {
  const i = 1;
  return i < text.length ? text[i] : "-";
}

function digitsInLines(lines: string[]): number[] {
  const counts: number[] = [];
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r]!;
    let n = 0;
    for (let i = 0; i < line.length; i++) if (isDigit(line[i])) n++;
    counts.push(n);
  }
  return counts;
}

function codes(text: string): number[] {
  const out: number[] = [];
  const read = (): void => {
    for (let i = 0; i < text.length; i++) out.push(text[i].charCodeAt(0));
  };
  read();
  return out;
}

console.log(tokens("width 42 + height7 * (3)").join(" | "));
console.log(tokens("").length, tokens("   ").length, tokens("x").join(""));
console.log(
  reversed("stone"),
  JSON.stringify(reversed("")),
  everyOther("abcdefg"),
  everyOther(""),
);
console.log(firstNonSpace("   q"), firstNonSpace("    "), firstNonSpace(""));
console.log(countOf("banana", "a"), countOf("", "a"), countOf("€uro€", "€"));
console.log(
  JSON.stringify(trimRight("pad   ")),
  JSON.stringify(trimRight("   ")),
  JSON.stringify(trimRight("")),
);
console.log(middle("ok"), middle("o"), middle(""));
console.log(digitsInLines(["a1", "22b", "", "x"]).join(","));
console.log(codes("A€z").join(","));
