// `Object.entries(value).filter(...)` inside a generic body. The checker
// spells the entry element as a deferred conditional over the lib
// overload's own type parameter
// (`[string, keyof T extends never ? unknown : T[keyof T]]`), which has no
// mapping; the filter rides the Object.entries lowerings concrete
// `[string, <value union>][]` instead, so the predicate sees the values the
// record really holds.
function compact<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

const options = { client_id: "abc", error: undefined as string | undefined, meta: { on: true } };
console.log(JSON.stringify(compact(options)));
console.log(JSON.stringify(compact({ a: 1, b: 2 })));

// The same receiver through a `const` binding and through `.map`/`.some`:
// one lowered entry array either way.
function describe<T extends object>(value: T): string {
  const entries = Object.entries(value);
  const defined = entries.filter(([, item]) => item !== undefined);
  const mapped = defined.map(([key, item]) => `${key}=${String(item)}`);
  const anyObject = mapped.some((part) => part.includes("meta"));
  return `${entries.length}/${defined.length}/${anyObject}:${mapped.join("&")}`;
}
console.log(describe({ a: 1, b: undefined as number | undefined, meta: { on: true } }));

// A written predicate over the same receiver narrows to the value union.
function numbers<T extends object>(value: T): string {
  return Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([key, item]) => `${key}:${item + 1}`)
    .join(",");
}
console.log(numbers({ a: 1, b: "x", c: 3 }));
