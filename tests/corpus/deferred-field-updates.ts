class State {
  count!: number;
  label!: string;
  constructor(initialize: boolean) { if (initialize) { this.count = 2; this.label = "a"; } }
}
let receivers = 0;
let operands = 0;
const state = new State(true);
function receiver(): State { receivers++; return state; }
function operand(): number { operands++; state.count = 20; return 3; }
console.log(receiver().count += operand(), state.count, receivers, operands);
console.log(state.count++, ++state.count, state.count--, --state.count);
state.count *= 4;
state.count %= 7;
state.label += "b";
console.log(state.count, state.label);
const empty = new State(false);
empty.count += 1;
console.log(Number.isNaN(empty.count));
