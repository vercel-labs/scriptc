// URLSearchParams.forEach(callback[, thisArg]): the optional second argument
// is the callback's `this`, exactly Node's binding. The walk stays the live
// index walk: appends are visited and deletes shift later entries.
interface Tally {
  hits: number;
  tag: string;
}

const params = new URLSearchParams("a=1&b=2&c=3");
const seen: string[] = [];
const tally: Tally = { hits: 0, tag: "T" };

params.forEach(function (this: Tally, value: string, name: string, parent: URLSearchParams) {
  this.hits += 1;
  seen.push(name + "=" + value + ":" + this.tag + ":" + (parent === params));
}, tally);
console.log(seen.join(","), tally.hits);

// An arrow keeps its lexical this; the thisArg never reaches it.
const box = { tag: "arrow" };
const tags: string[] = [];
params.forEach((value, name) => {
  tags.push(name + ":" + box.tag);
}, tally);
console.log(tags.join(","), tally.hits);

// A call without a thisArg keeps the ambient receiver.
let ambient = "none";
params.forEach(function (this: unknown, value: string) {
  ambient = String(this);
});
console.log("ambient", ambient);

// Live iteration with a thisArg.
const grow = new URLSearchParams("a=1");
const hits: string[] = [];
grow.forEach(function (this: Tally, value: string, name: string) {
  hits.push(name + this.tag);
  if (hits.length < 3) grow.append(name + "x", value);
}, tally);
console.log(hits.join(","), grow.size);
