// Functions held in records, arrays and maps keep their JavaScript names
// when the value is converted to unknown: util.inspect prints them.
function declared() {
  return 0;
}
const named = function inner() {
  return 1;
};
const arrow = () => 2;
const wide = {
  a: 1,
  toString() {
    return "w";
  },
  h: () => 3,
  g: named,
  d: declared,
  "quoted"() {
    return 4;
  },
};
const box: unknown = wide;
console.log(box);
const list: unknown = [declared, named, arrow];
console.log(list);
const byName = new Map<string, () => number>([["a", arrow]]);
const mapBox: unknown = byName;
console.log(mapBox);
const plain: unknown = { f: function () { return 5; } };
console.log(plain);
