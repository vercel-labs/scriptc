// Module-level bindings of an untyped module that a typed module imports.
export let total = 0;
let hidden = 0;
export function run(rounds) {
  for (let i = 0; i < rounds; i++) {
    total += i * 3;
    hidden += i;
  }
  return hidden;
}
export function reset(value) {
  total = value;
}
