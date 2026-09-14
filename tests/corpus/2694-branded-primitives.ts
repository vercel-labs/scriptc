// BRANDED primitives — the nominal-typing idiom. A brand member lives only
// in the type world, so the value IS the primitive: branded slots hold,
// pass, and compute exactly like their unbranded twins, whether the brand
// key is an ordinary property or a `unique symbol`.

type UserId = string & { readonly __brand: "UserId" };
type Meters = number & { readonly __brand: "Meters" };

declare const tag: unique symbol;
type Brand<T, B extends string> = T & { readonly [tag]: B };
type Slug = Brand<string, "Slug">;
type Ratio = Brand<number, "Ratio">;
type Verified = Brand<boolean, "Verified">;

function userId(raw: string): UserId {
  return raw as UserId;
}
function meters(raw: number): Meters {
  return raw as Meters;
}

// The primitive's own surface stays available on a branded value.
const id = userId("ada");
console.log(id, id.length, id.toUpperCase(), `<${id}>`);
console.log(id === userId("ada"), id < userId("bob"));

const width = meters(3.5);
console.log(width + 1.5, width * 2, width.toFixed(2), Math.max(width, meters(1)));

const slug = "hello-world" as Slug;
console.log(slug.split("-").join(" "), slug.startsWith("hello"));

const ratio = 0.25 as Ratio;
const verified = true as Verified;
console.log(ratio * 4, verified ? "yes" : "no", !verified);

// The brand is type-level only: the runtime value is the bare primitive.
console.log(typeof id, typeof width, typeof verified, String(width));

// Branded values flow through every container slot.
const ids: UserId[] = [userId("ada"), userId("bob"), userId("cy")];
console.log(ids.join(","), ids.map((u) => u.length).join("|"));

const seen = new Set<UserId>(ids);
console.log(seen.size, seen.has(userId("bob")));

const scores = new Map<UserId, Meters>();
scores.set(userId("ada"), meters(12));
console.log(scores.get(userId("ada")) ?? meters(-1));

interface Row {
  readonly id: UserId;
  readonly depth: Meters;
}
const row: Row = { id: userId("cy"), depth: meters(7.25) };
console.log(row.id, row.depth, JSON.stringify(row));

// Unions, narrowing, and generics over a branded arm.
function label(value: UserId | null): string {
  return value === null ? "none" : value.padStart(5, ".");
}
console.log(label(userId("ada")), label(null));

function firstOf<T>(items: T[]): T {
  return items[0]!;
}
console.log(firstOf(ids), firstOf([width, meters(9)]));

// A branded parameter accepts the primitive's operations unchanged, and a
// branded return type is just the primitive coming back.
function totalDepth(rows: Row[]): Meters {
  let sum = 0;
  for (const r of rows) sum += r.depth;
  return sum as Meters;
}
console.log(totalDepth([row, { id: userId("bob"), depth: meters(2.75) }]));
