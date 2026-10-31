// Array operations on an Array subclass instance: iteration, spread,
// destructuring, the mutators that return the instance itself, searches,
// length writes, Array.isArray through unknown, instanceof through unknown,
// and JSON.
class Row extends Array<string> {
  tag = "row";
  #reads = 0;

  static of2(a: string, b: string): Row {
    const row = new Row();
    row.push(a, b);
    return row;
  }

  get size(): number {
    this.#reads++;
    return this.length;
  }

  get reads(): number {
    return this.#reads;
  }

  label(): string {
    return `${this.tag}:${this.join("|")}`;
  }
}

const r = new Row();
console.log(r.push("b", "a", "c"), r.length, r.label());
const [first, ...rest] = r;
console.log(first, rest, [...r].length);
for (const [i, v] of r.entries()) console.log(i, v);
console.log(r.sort() === r, r.label(), r.reverse() === r, r.label());
console.log(r.fill("x", 1) === r, r.label(), r.indexOf("x"), r.lastIndexOf("x"), r.at(-1));
console.log(r.pop(), r.shift(), r.length, r.unshift("z"), r.label());
r.length = 0;
console.log(r.length, r.label(), JSON.stringify({ r }));
const u: unknown = r;
console.log(Array.isArray(u), u instanceof Row, u instanceof Array);
const rows: Row[] = [new Row(), new Row()];
rows[1]!.push("q");
console.log(rows.map((row) => row.label()).join(" "));
console.log({ nested: rows[1] });
const pair = Row.of2("m", "n");
console.log(pair.size, pair.size, pair.reads, pair.label(), pair instanceof Row);
