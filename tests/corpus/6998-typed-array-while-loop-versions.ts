// While loops that scan typed arrays with a counter below a bound: scanners
// with nested loops and `&&` conditions, `| 0` increments, look-behind and
// look-ahead reads, writes, DataView reads, string-length bounds, and
// bounds or starts past the array, fractional, negative, -0 or NaN.

function words(bytes: Uint8Array, end: number): number {
  let pos = 0;
  let count = 0;
  while (pos < end) {
    while (pos < end && (bytes[pos] === 32 || bytes[pos] === 10)) pos++;
    if (pos < end) count++;
    while (pos < end && bytes[pos] !== 32 && bytes[pos] !== 10) pos++;
  }
  return count;
}

function identifiers(chars: Uint16Array, start: number, end: number): string {
  let pos = start;
  let count = 0;
  let mix = 0;
  while (pos < end) {
    let hash = 0x811c9dc5 | 0;
    while (pos < end) {
      const c = chars[pos]!;
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      hash = Math.imul(hash ^ c, 0x01000193);
      pos = (pos + 1) | 0;
    }
    mix = (mix + hash) | 0;
    count++;
    pos = (pos + 1) | 0;
  }
  return `${count} ${mix >>> 0} ${pos}`;
}

function around(values: Int16Array, start: number, end: number): number[] {
  const out: number[] = [];
  let i = start;
  while (i <= end) {
    out.push(values[i - 1]! + values[i + 2]! * 2);
    i += 1;
  }
  return out;
}

function fill(out: Float32Array, end: number, value: number): number {
  let i = 0;
  while (i < end) {
    out[i] = value + i;
    if (i < end - 1 && out[i] > 2) {
      i += 2;
      continue;
    }
    i++;
  }
  return i;
}

function afterInner(bytes: Uint8Array): number {
  let pos = 0;
  let sum = 0;
  while (pos < bytes.length) {
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    // The inner loop may stop at the length: this read stays checked.
    sum += bytes[pos] ?? -1;
    pos++;
  }
  return sum;
}

function firstAbove(samples: Float64Array, limit: number): number {
  let i = 0;
  while (i < samples.length) {
    if (samples[i]! > limit) return i;
    i = i + 1;
  }
  return -1;
}

function halves(view: DataView, end: number): number {
  let at = 0;
  let total = 0;
  while (at < end) {
    total += view.getUint16(at, true);
    at += 2;
  }
  return total;
}

function letters(text: string, codes: Uint8Array): number {
  let i = 0;
  let sum = 0;
  while (i < text.length) {
    sum += codes[i]! * (text.charCodeAt(i) & 7);
    i++;
  }
  return sum;
}

function notCounters(bytes: Uint8Array): string {
  let i = 1;
  let doubled = 0;
  while (i < bytes.length) {
    doubled += bytes[i]!;
    i = i * 2;
  }
  let j = bytes.length - 1;
  let down = 0;
  while (j < bytes.length && j >= 0) {
    down += bytes[j]!;
    j--;
  }
  return `${doubled} ${down}`;
}

const text = "let  alpha = beta_gamma\nreturn delta  ";
const bytes = new Uint8Array(text.length);
const chars = new Uint16Array(text.length);
for (let i = 0; i < text.length; i++) {
  bytes[i] = text.charCodeAt(i);
  chars[i] = text.charCodeAt(i);
}
console.log("words", words(bytes, bytes.length), words(bytes, 10), words(bytes, bytes.length + 5), words(bytes, 7.5), words(bytes, NaN));
console.log("identifiers", identifiers(chars, 0, chars.length));
console.log("identifiers past end", identifiers(chars, 4, chars.length + 3));
console.log("identifiers starts", identifiers(chars, -2, 9), identifiers(chars, 2.5, 12), identifiers(chars, -0, 6));

const values = new Int16Array([5, -6, 7, -8, 9, -10, 11]);
console.log("around", around(values, 1, 4).join(","), around(values, 0, 6).join(","), around(values, -1, 1).join(","));

const floats = new Float32Array(6);
console.log("fill", fill(floats, 6, 0.5), floats.join(","));
const short = new Float32Array(3);
console.log("fill past end", fill(short, 5, 1), short.join(","));

console.log("after inner", afterInner(new Uint8Array([1, 2, 0, 3, 0, 4, 5])));
console.log("first above", firstAbove(new Float64Array([0.5, 1.5, 2.5]), 1), firstAbove(new Float64Array([0.5]), 1));

const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const view = new DataView(buffer.buffer);
console.log("halves", halves(view, 8));
try {
  console.log("halves past end", halves(view, 10));
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}

console.log("letters", letters("abcdef", new Uint8Array([1, 2, 3, 4, 5, 6])), letters("abcdefgh", new Uint8Array([1, 2, 3])));
console.log("not counters", notCounters(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])));
