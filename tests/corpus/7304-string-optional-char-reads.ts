// s[i] with an index not proven in bounds, tested against one-unit
// literals: equality, inequality and ordered comparisons on either side,
// peeks at i - 1 and i + 1, tests for undefined, switches, character
// locals with and without other uses, fractional, negative, -0, NaN and
// infinite indices, reads past the end, a two-unit literal, Object.is, a
// class-based lexer with its position in a field, and ASCII, Latin-1, BMP,
// surrogate pairs, lone surrogates and empty strings.

class Lexer {
  pos = 0;
  src: string;
  constructor(src: string) {
    this.src = src;
  }
  skipSpaces(): void {
    const src = this.src;
    let pos = this.pos;
    while (pos < src.length && (src[pos] === " " || src[pos] === "\t")) pos++;
    this.pos = pos;
  }
  word(): string {
    const src = this.src;
    const start = this.pos;
    let pos = start;
    while (pos < src.length) {
      const c = src[pos];
      if ((c < "a" || c > "z") && (c < "0" || c > "9")) break;
      pos++;
    }
    this.pos = pos;
    return src.slice(start, pos);
  }
  operator(): string {
    const src = this.src;
    const c = src[this.pos];
    switch (c) {
      case "=":
        this.pos += src[this.pos + 1] === "=" ? 2 : 1;
        return src[this.pos - 1] === "=" && src[this.pos - 2] === "=" ? "==" : "=";
      case "+":
      case "-":
        this.pos++;
        return c;
      case undefined:
        return "";
      default:
        this.pos++;
        return "?";
    }
  }
  tokens(): string[] {
    const out: string[] = [];
    while (this.pos < this.src.length) {
      this.skipSpaces();
      const w = this.word();
      if (w !== "") out.push(w);
      else if (this.pos < this.src.length) out.push(this.operator());
    }
    return out;
  }
}

function tests(src: string, pos: number): string {
  const bits: number[] = [];
  bits.push(src[pos] === " " ? 1 : 0, src[pos] !== "x" ? 1 : 0);
  bits.push(src[pos] < "a" ? 1 : 0, src[pos] <= "a" ? 1 : 0);
  bits.push(src[pos] > "a" ? 1 : 0, src[pos] >= "a" ? 1 : 0);
  bits.push("m" < src[pos] ? 1 : 0, "m" >= src[pos] ? 1 : 0);
  bits.push(src[pos + 1] === "b" ? 1 : 0, src[pos - 1] > "\0" ? 1 : 0);
  bits.push(src[pos] === undefined ? 1 : 0, src[pos] !== undefined ? 1 : 0);
  bits.push(src[pos * 2] === undefined ? 1 : 0, src[pos] === "ab" ? 1 : 0);
  bits.push(Object.is(src[pos], "a") ? 1 : 0);
  return bits.join("");
}

function local(src: string, pos: number): string {
  const c = src[pos];
  let n = 0;
  if (c === undefined) n += 1;
  if (c !== undefined && c >= "a") n += 2;
  if ("z" > c) n += 4;
  switch (c) {
    case "é":
      n += 8;
      break;
    case "b":
      n += 16;
      break;
    default:
      n += 32;
  }
  return String(n);
}

function kept(src: string, pos: number): string {
  const c = src[pos];
  if (c === " ") return "space";
  return c ?? "end";
}

const samples = ["abc", "", " ", "a b\tc", "café", "日本 語", "😀x", "\uD800z", "ab=b"];
const indices = [0, 1, 2, 3, -1, -0, 0.5, 1.5, NaN, Infinity, 10];
for (const s of samples) {
  const row: string[] = [];
  for (const i of indices) row.push(`${tests(s, i)}:${local(s, i)}:${kept(s, i)}`);
  console.log(JSON.stringify(s), row.join(" "));
}

const programs = [
  "let x = a + b - c",
  "  alpha==beta  gamma = delta1 ",
  "x=y==z+",
  "",
  "abc é def",
  "\tq\t=\t9",
];
for (const p of programs) console.log(JSON.stringify(p), JSON.stringify(new Lexer(p).tokens()));

let text = "";
for (let k = 0; k < 30; k++) text += (k % 4 === 0 ? "==" : "w" + k) + " ";
console.log(new Lexer(text).tokens().length, new Lexer(text).tokens().slice(0, 6).join(","));
