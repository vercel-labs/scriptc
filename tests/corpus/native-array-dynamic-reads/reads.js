export function sumAll(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
export function lengths(arrays) {
  const out = [];
  for (const array of arrays) out.push(array.length);
  return out;
}
export function describe(values) {
  const parts = [];
  for (const value of values) parts.push(typeof value === "object" ? value.sku : value);
  return parts.join("+");
}
export function stepper(values) {
  const iterator = values[Symbol.iterator]();
  const next = iterator.next;
  const out = [];
  for (let step = next.call(iterator); !step.done; step = next.call(iterator)) out.push(step.value);
  out.push(typeof iterator.next, iterator.next === next);
  return out;
}
export async function asyncKinds(generator, array) {
  const out = [];
  for await (const value of generator) out.push(value);
  for (const value of array) out.push(value);
  return out;
}
