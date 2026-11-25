// FormData's iteration members: entries(), keys() and values() step the
// live entry list in insertion order, the form itself iterates its pairs
// (spread, Array.from, for-of), and forEach calls back with (value, name,
// form) under the given thisArg, all as Node answers them.

const form = new FormData();
form.append("a", "1");
form.append("b", new File(["xy"], "b.txt"));
form.append("a", "2");
console.log([...form].map(([key, value]) => [key, typeof value === "string" ? value : value.name]));
console.log([...form.keys()], [...form.values()].map((v) => (typeof v === "string" ? v : v.name)));
const seen = [];
form.forEach((value, key, self) => {
  seen.push([key, typeof value === "string" ? value : value.name, self === form]);
}, { tag: 1 });
console.log(JSON.stringify(seen));
console.log(Array.from(form).length, Array.from(form.entries()).length);
const iterator = form.entries();
console.log(JSON.stringify(iterator.next().value[0]), iterator.next().done);
try {
  form.forEach("nope");
} catch (error) {
  console.log("bad callback", error.name, error.message);
}
try {
  form.forEach();
} catch (error) {
  console.log("no callback", error.name, error.message);
}
