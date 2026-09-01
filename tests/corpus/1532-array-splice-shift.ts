// Array.prototype.splice (removal and replacement forms) and .shift —
// Node-exact return values and index handling: relative/clamped start,
// clamped deleteCount, splice(start) removing to the end, shift's undefined
// on an empty array. The portless stripGlobalFlag idiom (find a flag, splice
// it and its value out) drives the string-array shapes.
const nums = [10, 20, 30, 40, 50, 60];
console.log(JSON.stringify(nums.splice(1, 2)), JSON.stringify(nums));
console.log(JSON.stringify(nums.splice(-2, 1)), JSON.stringify(nums));
console.log(JSON.stringify(nums.splice(0, 0)), JSON.stringify(nums));
console.log(JSON.stringify(nums.splice(2, 99)), JSON.stringify(nums));
console.log(JSON.stringify(nums.splice(-99, 1)), JSON.stringify(nums));
console.log(JSON.stringify(nums.splice(1)), JSON.stringify(nums));
console.log(JSON.stringify(nums.splice(5, 3)), JSON.stringify(nums));
console.log(JSON.stringify(nums.splice(0, -1)), JSON.stringify(nums));
console.log(JSON.stringify(nums.splice(0.9, 1.8)), JSON.stringify(nums));

// Variadic replacement items evaluate before the receiver mutates and keep
// source order, including zero-delete insertion.
const spliceItems: number[] = [10, 20, 30, 40];
console.log(JSON.stringify(spliceItems.splice(1, 2, spliceItems.length, spliceItems.length + 1)), JSON.stringify(spliceItems));
console.log(JSON.stringify(spliceItems.splice(1, 0, 7, 8)), JSON.stringify(spliceItems));

// shift: the first element out, the tail sliding down; undefined when
// empty. Number elements exercise the union-boxed scalar path.
const q = [1, 2];
console.log(q.shift() ?? -1, JSON.stringify(q));
console.log(q.shift() ?? -1, JSON.stringify(q));
console.log(q.shift() === undefined, JSON.stringify(q), q.length);

// The stripGlobalFlag idiom over string args (portless cli.ts).
const args = ["--name", "myapp", "run", "--", "--port", "3000"];
const stripFlag = (flag: string, hasValue: boolean): string | boolean | null => {
  const sep = args.indexOf("--");
  const end = sep === -1 ? args.length : sep;
  const idx = args.indexOf(flag);
  if (idx === -1 || idx >= end) return null;
  if (!hasValue) {
    args.splice(idx, 1);
    return true;
  }
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) return false;
  args.splice(idx, 2);
  return value;
};
const v1 = stripFlag("--name", true);
console.log(typeof v1 === "string" ? v1 : "?", JSON.stringify(args));
console.log(stripFlag("--port", true) === null, JSON.stringify(args));
console.log(stripFlag("run", false) === true, JSON.stringify(args));
const first = args.shift();
console.log(first ?? "-", JSON.stringify(args));

// Ref elements (records): removed rows keep identity through the result.
interface Row {
  id: number;
}
const rows: Row[] = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
const keep = rows[2]!;
const removed = rows.splice(1, 2);
console.log(JSON.stringify(removed), JSON.stringify(rows));
console.log(removed[1] === keep);
const replacementRow: Row = { id: 9 };
const replaced = rows.splice(1, 1, replacementRow);
replacementRow.id = 10;
console.log(JSON.stringify(replaced), JSON.stringify(rows), rows[1] === replacementRow);
const head = rows.shift();
console.log(head ? head.id : -1, JSON.stringify(rows), rows.length);
