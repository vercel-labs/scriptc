// @requires-icu
// Intl.ListFormat over the typed surface: a locale and the options object,
// and format() over a string array (an iterable of strings at run time).

const list = new Intl.ListFormat("en", { type: "conjunction", style: "long" });
const items: string[] = ["alpha", "beta", "gamma"];
console.log(list.format(items));
console.log(list.format([]));
console.log(new Intl.ListFormat("en", { type: "disjunction" }).format(["a", "b", "c"]));
console.log(new Intl.ListFormat("en", { type: "unit" }).format(["5 pounds", "12 ounces"]));
console.log(new Intl.ListFormat("en", { style: "short" }).format(["a", "b", "c"]));
