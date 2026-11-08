// @requires-libnode
// An iterator that crosses a Node island keeps its identity and its
// position. An island iterator the program holds with a generator type is
// one value in the program however often it crosses, and the island's own
// iterator again when it goes back. A generator the program made comes back
// from the island as itself. Both sides step one iterator: a value read on
// one side is consumed on the other.
import {
  queue,
  sides,
  endless,
  current,
  currentSides,
  currentStepper,
  currentLoose,
  hold,
  isCurrent,
  isCurrentSides,
  isCurrentStepper,
  isCurrentLoose,
  upcoming,
  withCurrent,
} from "tunes";

type Tracks = Generator<string, void, undefined>;

function through(it: Tracks): Tracks {
  return it;
}

// A generator the island made, back in the island.
const made: Tracks = queue();
console.log("back directly", isCurrent(made));
console.log("back through a parameter", isCurrent(through(made)));
const shelf = { slot: made };
console.log("back through a field", isCurrent(shelf.slot));
const later = (): Tracks => made;
console.log("back through a closure", isCurrent(later()));
console.log("back as an untyped value", isCurrentLoose(made));

// The same island generator, asked for again.
console.log("again", current() === made, current() === current());
const plays = new Map<unknown, number>([[made, 1]]);
console.log("map key", plays.get(current()), plays.get(currentLoose()));
console.log("set member", new Set<unknown>([made]).has(current()));
const loose: any = current();
const typed: Tracks = loose;
console.log("through any", typed === made, isCurrentLoose(typed));
const opaque: unknown = made;
console.log("through unknown", (opaque as Tracks) === made, isCurrent(opaque as Tracks));
console.log("handed in and back", hold(made) === made);
console.log(
  "as a callback's argument",
  withCurrent((it) => it === made),
);

// One position on both sides.
console.log("program reads", made.next().value, "island reads", upcoming());
console.log("island reads", upcoming(), "program reads", made.next().done);

// An island generator that never ends is read one value at a time.
const numbers: Generator<number, void, undefined> = endless();
console.log("endless", numbers.next().value, numbers.next().value, upcoming(), numbers.next().value);

// An island array iterator under two generator types.
const letters: IterableIterator<string> = sides();
const stepper: Iterator<string> = currentStepper();
console.log("two types", isCurrentSides(letters), isCurrentStepper(stepper));
console.log("two types again", currentSides() === letters, currentStepper() === stepper);
console.log("two types step", letters.next().value, stepper.next().value, upcoming());

// A generator the program made, handed to the island and back.
function* chorus(): Tracks {
  yield "la";
  yield "la la";
}
const own = chorus();
const back: Tracks = hold(own);
console.log("own back", back === own, current() === own);
console.log("own map key", new Map<unknown, number>([[own, 2]]).get(back));
console.log("own twice in the island", isCurrent(own), isCurrent(through(own)));
console.log("own steps", own.next().value, back.next().value, own.next().done);
