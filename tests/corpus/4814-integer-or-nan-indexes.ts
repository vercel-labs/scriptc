// Typed-array and array indexes that are exact integers or NaN: element
// reads that may miss, bound to locals or used inline, `charCodeAt` past
// either end, and sums of those. A NaN index reads undefined and a write
// to it is ignored; negative and too-large integers miss the same way.
function show(label: string, value: number | undefined): void {
  console.log(label, value);
}

const bytes = new Uint8Array([65, 67, 71, 84, 0, 255, 3]);
const signed = new Int8Array([-1, 2, -128, 127, 5]);
const wide = new Uint32Array([1, 4294967295, 2, 7]);
const halves = new Int16Array([-300, 4, 6]);
const table = new Int32Array(256);
for (let i = 0; i < 256; i++) table[i] = i * 3 - 100;
const list: number[] = [];
for (let i = 0; i < 300; i++) list.push(i * 0.5);

function lookups(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i]!;
    const t = table[c];
    acc = (acc * 7 + (t === undefined ? -1 : t)) % 1000003;
  }
  return acc;
}

function listLookups(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i]!;
    const v = list[c];
    acc = acc * 3 + (v === undefined ? -2 : v);
  }
  return acc;
}

function signedIndexes(): string {
  const out: string[] = [];
  for (let i = -1; i <= signed.length; i++) {
    const s = signed[i]!;
    out.push(String(table[s]), String(list[s + 2]), String(bytes[s - 1]));
  }
  return out.join(",");
}

function wideIndexes(): string {
  const out: string[] = [];
  for (let i = 0; i <= wide.length; i++) {
    const w = wide[i]!;
    out.push(String(bytes[w]), String(list[w]), String(table[w - 1]));
  }
  for (let i = 0; i <= halves.length; i++) {
    const h = halves[i]!;
    out.push(String(table[h + 301]), String(list[h]));
  }
  return out.join(",");
}

function codeUnits(s: string): number {
  let acc = 0;
  for (let i = -2; i < s.length + 2; i++) {
    const u = s.charCodeAt(i);
    const t = table[u];
    acc = acc * 5 + (t === undefined ? 1 : t);
    acc %= 1000003;
  }
  return acc;
}

function writes(n: number): string {
  const counts = new Uint16Array(8);
  const tally: number[] = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const c = bytes[i]!;
    counts[c & 7]++;
    counts[c - 60] = 9;
    tally[c - 65] = (tally[c - 65] ?? 0) + 1;
  }
  return `${Array.from(counts).join(" ")} | ${tally.join(" ")} | ${tally.length}`;
}

function reassigned(n: number): string {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let c = bytes[i]!;
    if (c > 200) c = signed[i - 5]!;
    out.push(table[c] ?? -7);
    // A fraction makes `f` an ordinary number index.
    let f = bytes[i]!;
    if (i === 2) f = f / 2;
    out.push(list[f] ?? -8);
  }
  return out.join(" ");
}

function growing(n: number): number {
  let x = bytes[0]!;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    x = x + bytes[i]!;
    acc = acc + (table[x] ?? -3);
  }
  return acc;
}

function hashes(n: number): string {
  let h = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i]!;
    h = (h * 31 + c) | 0;
    k = ((k << 2) | (c >> 1)) & 0xffff;
  }
  return `${h} ${k}`;
}

show("lookups", lookups(bytes.length));
show("lookups past the end", lookups(bytes.length + 3));
show("list lookups", listLookups(bytes.length + 2));
console.log("signed", signedIndexes());
console.log("wide", wideIndexes());
show("code units", codeUnits("ACGTÿĀ"));
console.log("writes", writes(bytes.length + 2));
console.log("reassigned", reassigned(bytes.length + 1));
show("growing", growing(bytes.length + 1));
console.log("hashes", hashes(bytes.length + 2));
