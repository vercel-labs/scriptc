// String.prototype.at on strings held in untyped (checked-dynamic) values,
// as Hono's mergePath reads `base?.at(-1)`.
const mergePath = (base, sub, ...rest) => {
  if (rest.length) sub = mergePath(sub, ...rest);
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
};
console.log(mergePath("/api", "/users"), mergePath("api/", "/"), mergePath("/a", "b", "/c"));
const values = JSON.parse(`["hello", "", "a\\ud83d\\ude00b"]`);
for (const v of values) console.log(JSON.stringify([v.at(0), v.at(-1), v.at(1), v.at(99), v.at(-99), v.at(1.7), v.at()]));
