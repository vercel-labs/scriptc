// @transform-types
function update(values: number[], index: number): void {
  let value = values[index];
  const post = value++;
  const pre = ++value;
  const down = value--;
  const last = --value;
  console.log(post, pre, down, last, value, Object.is(post, -0));
  value = values[index + 1];
  value++;
  --value;
  console.log(value, Number.isNaN(value));
}
update([3, 8], 0);
update([-0], 0);
update([], 4);

const positions = [1, 3, 5];
let visited = "";
for (let i = 0; i < positions.length; i++) {
  for (let j = positions[i]; j < 7; j++) visited += String(j);
}
console.log(visited);
let captured = positions[0];
function next(): number { return captured++; }
console.log(next(), next(), captured);

class Counter {
  static value = positions[0];
}
console.log(Counter.value++, ++Counter.value, Counter.value);
Counter.value = positions[99];
Counter.value++;
console.log(Counter.value, Number.isNaN(Counter.value));

namespace State {
  export let value = positions[1];
}
console.log(State.value++, --State.value);
State.value = positions[99];
State.value++;
console.log(Number.isNaN(State.value));

class Deferred {
  static value = 3;
  static copy = Counter.value;
}
Deferred.value = positions[99];
console.log(Deferred.value++, ++Deferred.copy);
if (Counter.value !== undefined) console.log(Counter.value + 1);

class OptionalCounter {
  static value: number | undefined = positions[0];
}
OptionalCounter.value = positions[99];
console.log(OptionalCounter.value === undefined, Number.isNaN(OptionalCounter.value));
console.log(OptionalCounter.value++, Number.isNaN(OptionalCounter.value));
