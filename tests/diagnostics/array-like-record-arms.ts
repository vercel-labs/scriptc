// An array value in a union whose array-like object arm accepts it
// (`{ length: number; [index: number]: number }`) stays the array when
// every other arm has a checked-dynamic form (corpus 7729). Beside a class
// instance arm the union keeps its typed arms, and the array, which no arm
// holds, is refused at the flow instead of compiling into a run-time
// TypeError.
class Box {
  constructor(readonly size: number) {}
}
type Like = { length: number; [index: number]: number };
type Slot = Box | Like;

function describe(s: Slot): string {
  return s instanceof Box ? "box " + s.size : "like " + s.length;
}

const numbers = [1, 2];
const bound: Slot = numbers;
console.log(describe(bound), describe(new Box(3)));
