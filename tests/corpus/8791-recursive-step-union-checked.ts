// A function type whose result union holds a function of the same type
// again, with no record on the cycle: a step that answers the next step or a
// final number. The closure crosses an `unknown` slot and is checked back
// into the step type, so both conversion directions walk the cycle.
type Step = (() => Step) | number;

function run(step: Step): number {
  let turns = 0;
  let current: Step = step;
  while (typeof current === "function") {
    current = current();
    turns++;
  }
  return turns * 100 + current;
}

function hold(value: unknown): unknown {
  return value;
}

let left = 3;
const countdown = (): Step => (left-- > 0 ? countdown : 7);
const held = hold(countdown) as () => Step;
console.log(typeof held, run(held));

left = 1;
const again = hold(countdown) as () => Step;
console.log(again === held, run(again));
