// A URLSearchParams init that spreads a closed record copies the source's
// present fields at the spread's position and appends them in the source's
// own key order. An omitted optional property contributes no entry, an
// explicit undefined one appends "undefined", and a later initializer that
// mutates the source cannot change what the spread copied.
interface Options {
  device_code?: string;
  refresh_token?: string;
}
interface Pair {
  beta: string;
  alpha: string;
}
interface One {
  a: string;
}
interface Token {
  device_code: string;
}

function options(body: Options): Options {
  return body;
}
function pair(): Pair {
  log += "p";
  return { beta: "2", alpha: "1" };
}
let log = "";

// Omitted optional properties append nothing; an explicit undefined is an
// own key, so it appends its ToString.
console.log(new URLSearchParams({ x: "0", ...options({}) }).toString());
console.log(new URLSearchParams({ x: "0", ...options({ device_code: undefined }) }).toString());
console.log(new URLSearchParams({ x: "0", ...options({ refresh_token: "r" }) }).toString());

// The source's insertion order, not the shape's field order.
console.log(new URLSearchParams({ z: "0", ...pair() }).toString());

// The spread copies the values where it stands: a later initializer that
// mutates the source, and a source evaluated after an earlier initializer
// with effects, both keep the source order's answers.
const one: One = { a: "old" };
const mutating = new URLSearchParams({ ...one, b: (one.a = "new", "2") });
console.log(mutating.toString());
console.log(one.a);
const ordered = new URLSearchParams({
  a: `${((log += "a"), "1")}`,
  ...pair(),
  c: `${((log += "c"), "3")}`,
});
console.log(ordered.toString());
console.log(log);

// Integer index keys sort ascending ahead of every other key across the
// merge, including a spread's own index key.
const indexed: { b: string; 0: string } = { b: "b", 0: "zero" };
console.log(new URLSearchParams({ y: "y", ...indexed }).toString());

// A record the program built in an order other than its type's enumerates in
// the order its own value carries.
interface Variant {
  p: string;
  q: string;
}
const reversed: Variant = { q: "2", p: "1" };
const declared: Variant = { p: "3", q: "4" };
console.log(new URLSearchParams({ z: "0", ...reversed }).toString());
console.log(new URLSearchParams({ z: "0", ...declared }).toString());

// A spread of a fresh literal copies the literal's properties in place.
console.log(new URLSearchParams({ a: "1", ...{ d: "4", c: "3" } }).toString());

// The Vercel CLI's device-token literal: its own keys first, then the
// spread's.
function token(body: Token): string {
  return new URLSearchParams({
    client_id: "cid",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    ...body,
  }).toString();
}
console.log(token({ device_code: "d-1" }));
