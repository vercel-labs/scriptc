// `xs[i] += s` on a `string[]` in a program that also stores elements
// through an untyped value and hands typed arrays to untyped code. The
// append reads and writes one element: a present element concatenates, a
// missing one concatenates as "undefined", in statement and in value
// position, for a local, a parameter, a class field and a record field.
// The neighbouring compound and logical assignments are pinned beside it.

function poke(target: any, i: number, v: unknown): void {
  target[i] = v;
}
const loose: any = JSON.parse("[1,2]");
poke(loose, 0, "x");

const words: string[] = ["a", "b"];
const nums: number[] = [1, 2];
const seenWords: unknown = words;
const seenNums: unknown = nums;
console.log(Array.isArray(seenWords), Array.isArray(seenNums), JSON.stringify(loose));

words[0] += "x";
words[words.length - 1] += "#";
words[3] += "y";
const appended = (words[1] += "z");
console.log(appended);
words[5] ??= "n";
words[0] ||= "o";
words[1] &&= "p";
const defaulted = (words[9] ??= "q");
console.log(JSON.stringify(words), defaulted);

nums[0] += 1;
nums[1] -= 1;
nums[2] += 1;
nums[3] -= 2;
nums[0] *= 3;
nums[0]++;
nums[1]--;
++nums[5];
nums[6] ??= 7;
nums[0] ||= 9;
nums[1] &&= 4;
const summed = (nums[0] += 2);
console.log(JSON.stringify(nums), summed);

const bytes = new Uint8Array(4);
bytes[0] += 5;
bytes[9] += 1;
bytes[1]++;
console.log(Array.from(bytes).join(","));

function append(rows: string[], more: string[]): void {
  const last = rows.length - 1;
  rows[last] += more[0];
  rows[last] += more[5];
}
const lines = ["first", "second"];
append(lines, ["!", "?"]);
lines[4] += "tail";
console.log(JSON.stringify(lines));

class Log {
  rows: string[] = ["x"];
  counts: number[] = [0];
  add(chunk: string): string {
    const parts = chunk.split("\n");
    if (this.rows.length > 0 && parts.length > 0) {
      this.rows[this.rows.length - 1] += parts[0];
      this.rows.push(...parts.slice(1));
    }
    this.counts[0] += parts.length;
    this.rows[5] += "?";
    return (this.rows[0] += "#");
  }
}
const log = new Log();
console.log(log.add("y\nz"), JSON.stringify(log.rows), JSON.stringify(log.counts));

const cache = { rows: ["k"], marks: [""], counts: [0] };
cache.rows[0] += "v";
cache.marks[cache.marks.length - 1] += cache.rows[0];
cache.counts[0] -= 1;
console.log(JSON.stringify(cache));

const optional: (string | undefined)[] = ["a", undefined];
optional[0] += "x";
optional[1] += "y";
optional[3] += "z";
console.log(JSON.stringify(optional));

const grid: string[][] = [["a"], ["b"]];
grid[1]![0] += "c";
grid[0]![1] += "d";
console.log(JSON.stringify(grid));

function tail(parts: string[], extra: string | undefined, n: number): void {
  parts[parts.length - 1] += extra;
  parts[0] += n;
  parts[1] += `${n}:${extra}`;
}
const parts = ["p", "q", "r"];
tail(parts, undefined, 7);
tail(parts, "e", 8);
console.log(JSON.stringify(parts));
