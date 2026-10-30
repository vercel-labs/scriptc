// While loops bounded by a typed array or Buffer length, with companion
// counters that only grow: reversed copies with line breaks, steps of two,
// early exits, skipped passes, nested loops and loops inside loops.

function reverseLines(
  line: Uint8Array,
  target: Uint8Array,
  start: number,
): number {
  const len = line.length;
  const right = len - 1;
  let read = 0;
  let written = 0;
  let count = 0;
  let lines = 0;
  while (read < len) {
    let c = line[right - read]!;
    read++;
    if (c === 10) {
      if (read === len) break;
      c = line[right - read]!;
      read++;
    }
    target[written] = c + 1;
    written++;
    count++;
    if ((count + start - lines) % 5 === 0) {
      target[written] = 10;
      written++;
      count++;
      lines++;
    }
  }
  return written * 1000 + lines * 10 + count;
}

const text = Buffer.from("ABCDEFGHIJ\nKLMNOPQRST\nUVWXYZ\n");
const out = new Uint8Array(64);
for (const start of [0, 1, 3, 7]) {
  const summary = reverseLines(text, out, start);
  console.log(
    start,
    summary,
    Buffer.from(out.subarray(0, Math.floor(summary / 1000))).toString("latin1"),
  );
}

function pairs(values: Uint16Array): number[] {
  let i = 0;
  let sums = 0;
  let odd = 0;
  const result: number[] = [];
  while (i < values.length) {
    i += 2;
    sums++;
    if ((values[i - 2]! & 1) === 1) odd += 3;
    result.push(values[i - 2]! + (values[i - 1] ?? -1));
  }
  result.push(i, sums, odd);
  return result;
}
console.log(pairs(new Uint16Array([1, 2, 3, 4, 5])));
console.log(pairs(new Uint16Array(0)));
console.log(pairs(new Uint16Array([65535, 65535])));

function firstZero(bytes: Uint8Array): string {
  let i = 0;
  let seen = 0;
  let total = -5;
  while (i < bytes.length) {
    i++;
    if (bytes[i - 1] === 0) break;
    seen++;
    total += bytes[i - 1]!;
  }
  return `${i} ${seen} ${total}`;
}
console.log(
  firstZero(new Uint8Array([3, 4, 0, 9])),
  firstZero(new Uint8Array([1, 2])),
  firstZero(new Uint8Array(0)),
);

function skipping(bytes: Uint8Array): string {
  let i = 0;
  let kept = 0;
  let skipped = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    i++;
    if (b > 100) {
      skipped++;
      continue;
    }
    kept++;
  }
  return `${i} ${kept} ${skipped}`;
}
console.log(skipping(new Uint8Array([1, 200, 3, 250, 255, 7])));

function repeated(bytes: Uint8Array): string {
  let i = 0;
  let inner = 0;
  let outer = 0;
  while (i < bytes.length) {
    i++;
    outer++;
    let j = 0;
    while (j < bytes[i - 1]!) {
      j++;
      inner++;
    }
  }
  return `${i} ${outer} ${inner}`;
}
console.log(repeated(new Uint8Array([2, 0, 5, 1])));

function grid(rows: Float64Array[]): string {
  let total = 0;
  let cells = 0;
  for (const row of rows) {
    let k = 0;
    let doubled = 0;
    while (k < row.length) {
      k++;
      cells++;
      doubled += 2;
      total += row[k - 1]! * doubled;
    }
    total += k * 0.5;
  }
  return `${cells} ${total}`;
}
console.log(
  grid([
    new Float64Array([0.5, 1.5]),
    new Float64Array(0),
    new Float64Array([-2, 3, 4.25]),
  ]),
);

function views(buffer: ArrayBuffer): string {
  const view = new DataView(buffer, 2);
  let offset = 0;
  let words = 0;
  const parts: string[] = [];
  while (offset < view.byteLength) {
    offset += 2;
    words++;
    if (offset <= view.byteLength)
      parts.push(view.getUint16(offset - 2, true).toString(16));
  }
  return `${offset} ${words} ${parts.join(",")}`;
}
const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 5]).buffer;
console.log(views(backing));

function captured(bytes: Uint8Array): number {
  let i = 0;
  let n = 0;
  const read = (): number => n;
  while (i < bytes.length) {
    i++;
    n++;
  }
  return read() + i;
}
console.log(captured(new Uint8Array(4)));

function fromNegative(bytes: Int8Array): string {
  let i = 0;
  let level = -3;
  let low = -0;
  while (i < bytes.length) {
    i++;
    level++;
    if (bytes[i - 1]! < 0) low++;
  }
  return `${level} ${low} ${Object.is(low, -0)}`;
}
console.log(
  fromNegative(new Int8Array([-1, 2, -3])),
  fromNegative(new Int8Array(0)),
);

function throwing(bytes: Uint8Array): number {
  let i = 0;
  let n = 0;
  while (i < bytes.length) {
    i++;
    n++;
    if (bytes[i - 1] === 7) throw new Error(`stopped at ${i} after ${n}`);
  }
  return n;
}
try {
  console.log(throwing(new Uint8Array([1, 2])));
  console.log(throwing(new Uint8Array([1, 7, 3])));
} catch (error) {
  console.log((error as Error).message);
}
