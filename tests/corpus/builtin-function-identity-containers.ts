// A builtin function is one function however the program holds it: read
// from its module, passed through a generic helper, stored in an array, a
// record field, a Map or a Set, or held as an untyped value. Each of those
// compares equal to every other and reports the builtin's name and length.
import { basename, join } from "node:path";
import * as path from "node:path";

function viaArray<T>(value: T): T {
  const held: T[] = [value];
  return held[0] as T;
}
function viaField<T>(value: T): T {
  const box = { value };
  return box.value;
}
function viaUnknown<T>(value: T): T {
  const held: unknown = value;
  return held as T;
}
function viaClosure<T>(value: T): T {
  const read = (): T => value;
  return read();
}

const base = viaArray(basename);
console.log(base === path.basename, base === basename, typeof base);
console.log(base.name, base.length, base);
console.log(base("/one/two/file.ts"), base("/one/two/file.ts", ".ts"));

const direct = basename;
console.log(direct.name, direct.length, direct, direct === base);

const untyped: unknown = base;
console.log(untyped === basename, untyped === path.basename, untyped);

console.log(viaField(basename) === basename, viaUnknown(basename) === path.basename, viaClosure(basename) === base);
console.log(viaArray(join) === path.join, viaArray(join) === (basename as unknown));

const keyed = new Map<unknown, string>([[basename, "b"]]);
console.log(keyed.get(base), keyed.get(path.basename), keyed.has(join));
console.log(new Set<unknown>([basename, base, path.basename, join]).size);

const list = [basename, path.basename];
console.log(list[0] === list[1], list.indexOf(base), list.includes(path.basename));
const anyList: unknown[] = [base];
console.log(anyList.includes(basename), anyList.indexOf(path.basename), anyList[0] === direct);

const record = { fn: basename };
const loose: { fn: unknown } = { fn: base };
console.log(record.fn === loose.fn, record.fn === path.basename);

// `length` is Node's through every container too: a rest parameter does not
// count.
const joined = viaArray(join);
const resolved = viaField(path.resolve);
const untypedJoin: unknown = joined;
console.log(joined.length, join.length, path.join.length, resolved.length, path.resolve.length);
console.log((untypedJoin as typeof join).length, joined.name, resolved.name, joined("a", "b"));
const viaCast = viaUnknown(basename);
const viaRead = viaClosure(path.dirname);
const viaList = viaArray(path.extname);
console.log(viaCast.length, viaRead.length, viaList.name, viaList.length);
