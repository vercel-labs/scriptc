// Typed-array locals read from fields and parameters: reads while nothing
// replaces the field, the field replaced directly or by a callee while the
// local is in use, rebound parameters, views and detached-length reads.

class Scanner {
  chars: Uint16Array;
  pos = 0;
  constructor(text: string) {
    this.chars = Scanner.units(text);
  }
  static units(text: string): Uint16Array {
    const out = new Uint16Array(text.length + 2);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  }
  sum(): number {
    const chars = this.chars;
    let total = 0;
    for (let i = 0; i < chars.length; i++) total += chars[i]!;
    return total;
  }
  replaceThenRead(): number {
    const chars = this.chars;
    this.chars = Scanner.units("zz");
    return chars[0]! * 1000 + this.chars[0]!;
  }
  reset(text: string): void {
    this.chars = Scanner.units(text);
  }
  readAcrossReset(): string {
    const chars = this.chars;
    const before = chars[0]!;
    this.reset("q");
    return before + ":" + chars[1] + ":" + this.chars[0] + ":" + chars.length;
  }
}

function firstOf(units: Uint16Array, fallback: Uint16Array): number {
  if (units.length === 0) units = fallback;
  let n = 0;
  while (n < units.length && units[n] !== 0) n++;
  return n;
}

function walk(a: Uint8Array): number {
  let total = 0;
  while (a.length > 1) {
    total += a[0]!;
    a = a.subarray(1);
  }
  return total + a.length;
}

const s = new Scanner("hello");
console.log(s.sum(), s.replaceThenRead(), s.sum());
const t = new Scanner("abc");
console.log(t.readAcrossReset(), t.sum());
console.log(firstOf(new Uint16Array(0), Scanner.units("xyz")), firstOf(Scanner.units("ab"), new Uint16Array(1)));
console.log(walk(new Uint8Array([1, 2, 3, 4, 5])), walk(new Uint8Array(0)));

const holders: Scanner[] = [];
for (let i = 0; i < 50; i++) holders.push(new Scanner("item" + i));
let acc = 0;
for (const h of holders) {
  acc += h.sum();
  acc += h.replaceThenRead();
}
console.log(acc);
