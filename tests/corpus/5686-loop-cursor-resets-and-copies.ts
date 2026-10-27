// Loop cursors that a for loop resets, copies and counts (`run = 0`,
// `longest = run`, `lines++`): typed-array and array scans, exits through
// break, return and a caught exception, a labeled continue, loops that run
// zero times, cursors near 2^53, decrements and reads inside the loop.

function longestRun(values: Int32Array): number {
  let longest = 0;
  let run = 0;
  let changes = 0;
  let previous = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v >= 0) {
      run++;
      if (run > longest) longest = run;
    } else run = 0;
    if (v < 0 !== previous < 0) changes++;
    previous = v;
  }
  return longest * 1000 + changes;
}

function countBytes(bytes: Uint8Array): string {
  let lines = 0;
  let words = 0;
  let digits = 0;
  let inWord = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 10) lines++;
    if (b === 10 || b === 32) inWord = false;
    else if (!inWord) {
      inWord = true;
      words++;
    }
    if (b >= 48 && b <= 57) digits++;
  }
  return `${lines} ${words} ${digits}`;
}

function firstLongRun(values: number[], limit: number): number {
  let run = 0;
  let at = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i]! > 0) run++;
    else run = 0;
    if (run === limit) {
      at = i;
      break;
    }
  }
  return at * 100 + run;
}

function returnInside(values: number[]): number {
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === 0) return count;
    count++;
  }
  return -count;
}

function throwInside(values: number[]): number {
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i]! < 0) throw new Error(`negative after ${count}`);
    count++;
  }
  return count;
}

function caughtInside(values: number[]): string {
  let count = 0;
  try {
    for (let i = 0; i < values.length; i++) {
      if (values[i]! < 0) throw new Error("negative");
      count++;
    }
  } catch (error) {
    return `caught after ${count}`;
  }
  return `done ${count}`;
}

function labeled(rows: number[][]): number {
  let total = 0;
  let skipped = 0;
  outer: for (let r = 0; r < rows.length; r++) {
    let run = 0;
    for (let i = 0; i < rows[r]!.length; i++) {
      if (rows[r]![i]! < 0) {
        skipped++;
        continue outer;
      }
      run++;
    }
    total += run;
  }
  return total * 100 + skipped;
}

function nearLimit(): number[] {
  let up = 9007199254740981;
  let down = -9007199254740981;
  let copy = 0;
  for (let i = 0; i < 10; i++) {
    up++;
    down--;
    copy = up;
  }
  let untouched = 9007199254740991;
  for (let i = 0; i < 0; i++) untouched = untouched - 1;
  return [up, down, copy, up - 9007199254740981, untouched];
}

function readsInside(n: number): number {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (i % 3 === 0) count++;
    sum += count * 2 + i;
  }
  return sum;
}

function countDown(values: Float64Array): number {
  let remaining = values.length;
  let below = 0;
  for (let i = 0; i < values.length; i++) {
    remaining = remaining - 1;
    if (values[i]! < 0.5) below = below + 2;
    else below = below - 1;
  }
  return remaining * 1000 + below;
}

// The condition writes the copy's source on every pass, so the source's
// entry value does not bound the copy.
function copiesFromCondition(values: number[]): string {
  let source = 0;
  let cursor = 0;
  const seen: number[] = [];
  for (let i = 0; i < ((source = values[i] ?? 0), values).length; i++) {
    cursor = source;
    seen.push(cursor);
  }
  return seen.join(",");
}

const ints = new Int32Array(64);
for (let i = 0; i < ints.length; i++) ints[i] = ((i * 37) % 11) - 3;
console.log("longestRun", longestRun(ints), longestRun(new Int32Array(0)));
const text = new TextEncoder().encode("const value = 42;\nreturn x_y 7 plus 8\n\nend");
console.log("countBytes", countBytes(text), countBytes(new Uint8Array(0)));
console.log("firstLongRun", firstLongRun([1, 2, 0, 3, 4, 5, 6, 0], 3), firstLongRun([1, 0, 1], 5));
console.log("returnInside", returnInside([4, 5, 0, 6]), returnInside([1, 2, 3]));
try {
  throwInside([1, 2, -1, 4]);
} catch (error) {
  console.log("throwInside", (error as Error).message);
}
console.log("throwInside", throwInside([]));
console.log("caughtInside", caughtInside([3, 2, -1]), caughtInside([1, 2]));
console.log("labeled", labeled([[1, 2, 3], [4, -1, 5], [], [6, 7]]));
console.log("nearLimit", nearLimit().join(","));
console.log("readsInside", readsInside(10), readsInside(0));
const samples = new Float64Array(20);
for (let i = 0; i < samples.length; i++) samples[i] = (i * 0.37) % 1;
console.log("countDown", countDown(samples), countDown(new Float64Array(0)));
console.log("copiesFromCondition", copiesFromCondition([0.5, 1.25, 2.75]));
