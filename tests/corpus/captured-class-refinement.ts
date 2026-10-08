class Base { value = 1; }
class Child extends Base {
  extra = 2;
  read(): number { return this.value + this.extra; }
}
class Named { name = "named"; }
type Value = Base | Named | string;
function isChild(value: Value): value is Child { return value instanceof Child; }

function inspect(value: Value): number {
  const keep = (): Value => value;
  keep();
  if (isChild(value)) {
    value.extra += 3;
    return value.read();
  }
  return -1;
}
function asserted(value: Value): number {
  const keep = (): Value => value;
  keep();
  return (value as Child).read();
}
const child = new Child();
const values: Value[] = [child, new Named(), "text", new Base()];
for (const value of values) console.log(inspect(value));
console.log(asserted(values[0]));
for (const value of values) {
  if (isChild(value)) console.log(value.extra, value.read(), value === child);
}
const selected = values.filter((value) => value instanceof Child);
console.log(selected[0] === child, selected[0]!.read());
console.log(values.find((value) => value instanceof Child) === child);
console.log(values.findLast((value) => value instanceof Child) === child);
const empty: Value[] = [];
console.log(empty.find((value) => value instanceof Child) === undefined);
const changed: Value[] = [child, new Child(), "text"];
const kept = changed.filter((value, index, array) => {
  array[index] = "replaced";
  return value instanceof Child;
});
console.log(kept.length, kept[0] === child, changed[0] === "replaced");
try { asserted(values[20]); } catch (error) { console.log(error instanceof TypeError); }
