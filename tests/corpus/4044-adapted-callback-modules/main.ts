import { count, emit, has, off, on, widen, without } from "./registry.ts";

function first(value: number): void {
  console.log("first", value);
}
const second = (value: number): void => {
  console.log("second", value);
};
const wrapper = (value: number): void => first(value);

on(first);
on(second);
on(first);
console.log("registered", count(), has(first), has(second), has(wrapper));
console.log("filtered", without(first), without(second), without(wrapper));
console.log("widened", widen(first) === first, widen(first) === widen(first), widen(wrapper) === first);

console.log("off wrapper", off(wrapper), count());
console.log("off first", off(first), count());
emit(1);
console.log("off widened", off(widen(first)), count());
console.log("off again", off(first), count());
emit(2);
console.log("off second", off(second), count(), has(second));
