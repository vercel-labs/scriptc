// While loops that read a typed array or Buffer backwards from its length
// (`line[len - 1 - i]`, `line[right - i]`), with increments, guards that
// exit at the length, calls in the body, reads at or past either end, and
// counters advanced by nested loops.

function complement(code: number): number {
  switch (code) {
    case 65:
      return 84;
    case 67:
      return 71;
    case 71:
      return 67;
    case 84:
      return 65;
  }
  return 63;
}

function reverseComplement(line: Uint8Array, target: Uint8Array): string {
  const len = line.length;
  const right = len - 1;
  let ileft = 0;
  let iright = 0;
  let c: number;
  while (iright < len) {
    c = line[right - iright]!;
    iright++;
    if (c === 10) {
      if (iright === len) break;
      c = line[right - iright]!;
      iright++;
    }
    target[ileft] = complement(c);
    ileft++;
  }
  return Buffer.from(target.subarray(0, ileft)).toString("latin1");
}

const out = new Uint8Array(32);
console.log(reverseComplement(Buffer.from("ACGT\nTTGA\n"), out));
console.log(reverseComplement(Buffer.from("\nGATTACA"), out));
console.log(reverseComplement(Buffer.from("\n"), out));
console.log(reverseComplement(Buffer.from("A\n\nC"), out));
console.log(JSON.stringify(reverseComplement(new Uint8Array(0), out)));

// Reads one past the end: the first pass reads line[len], which is undefined.
function inclusive(line: Uint8Array): string {
  const len = line.length;
  let i = 0;
  const seen: (number | undefined)[] = [];
  while (i <= len) {
    seen.push(line[len - i]);
    i++;
  }
  return JSON.stringify(seen.map((v) => (v === undefined ? "u" : v)));
}
console.log(inclusive(new Uint8Array([1, 2, 3])), inclusive(new Uint8Array(0)));

// A read after an increment with no guard reads line[-1] on the last pass.
function unguarded(line: Uint8Array): string {
  const right = line.length - 1;
  let i = 0;
  let total = 0;
  let missing = 0;
  while (i < line.length) {
    total += line[right - i]!;
    i++;
    const next = line[right - i];
    if (next === undefined) missing++;
    else total += next * 100;
  }
  return `${total} ${missing}`;
}
console.log(unguarded(new Uint8Array([1, 2, 3])), unguarded(new Uint8Array([9])));

// Guards in other forms: >=, !==, and a guard in an else branch.
function guards(line: Uint16Array): number[] {
  const len = line.length;
  const result: number[] = [];
  let i = 0;
  while (i < len) {
    i += 1;
    if (i >= len) {
      result.push(-1);
      break;
    }
    result.push(line[len - 1 - i]!);
  }
  let j = 0;
  while (len > j) {
    j++;
    if (j !== len) result.push(line[len - 1 - j]! * 10);
    else result.push(-2);
  }
  let k = 0;
  while (k < len) {
    k++;
    if (line[0] === 0) {
      result.push(-3);
    } else if (k === len) {
      break;
    } else {
      result.push(line[len - k - 1]! * 100);
    }
  }
  return result;
}
console.log(guards(new Uint16Array([5, 6, 7])));
console.log(guards(new Uint16Array([0, 1])));
console.log(guards(new Uint16Array(0)));

// A nested loop advances the counter, so the read after it can fall
// outside the array.
function skipRuns(line: Uint8Array): string {
  const len = line.length;
  let i = 0;
  const parts: string[] = [];
  while (i < len) {
    const c = line[len - 1 - i]!;
    i++;
    while (i < len && line[len - 1 - i] === c) i++;
    const after = line[len - 1 - i];
    parts.push(`${c}:${after === undefined ? "end" : after}`);
  }
  return parts.join(" ");
}
console.log(skipRuns(Buffer.from("aabbbc")), skipRuns(Buffer.from("zz")));

// A condition with <= against the last index, a labeled block, and
// counters that start past zero or past the end.
function labeled(line: Int8Array, start: number): number[] {
  const len = line.length;
  const right = len - 1;
  const result: number[] = [];
  let i = start;
  while (i <= right) {
    found: {
      if (line[len - 1 - i]! < 0) break found;
      result.push(line[len - 1 - i]!);
    }
    i += 2;
  }
  result.push(i);
  return result;
}
console.log(labeled(new Int8Array([1, -2, 3, -4, 5]), 0));
console.log(labeled(new Int8Array([1, -2, 3, -4, 5]), 1));
console.log(labeled(new Int8Array([1, -2, 3]), 5));

// An exception thrown from a call in the body.
function throwing(line: Uint8Array): string {
  const len = line.length;
  let i = 0;
  let total = 0;
  try {
    while (i < len) {
      const c = line[len - 1 - i]!;
      i++;
      if (c === 0) throw new Error(`zero after ${total}`);
      total += c;
    }
  } catch (error) {
    return (error as Error).message;
  }
  return String(total);
}
console.log(throwing(new Uint8Array([4, 0, 2, 3])), throwing(new Uint8Array([1, 2])));

// An increment inside an if condition's comma expression: both reads are
// at index -1 on the last pass.
function commaIncrement(line: Uint8Array): string {
  const len = line.length;
  let i = 0;
  const out: (number | undefined)[] = [];
  while (i < len) {
    if ((i++, i > 0)) out.push(line[len - 1 - i]);
    const v = line[len - 1 - i]!;
    out.push(v);
  }
  return JSON.stringify(out);
}
console.log(commaIncrement(new Uint8Array([1, 2, 3])), commaIncrement(new Uint8Array(0)));
