// A dictionary type spelled in another module, and in a declaration file,
// is the same type as its spelling here: the value that passes between the
// two is one object.
import { count, touch } from "./shapes.ts";
import type { Declared, Listed } from "./ambient.d.ts";

function show(same: boolean, held: object, source: object, value: unknown): void {
  console.log(same, Object.keys(held).join(","), Object.keys(source).join(","), JSON.stringify(value));
}

const movedSource = { first: { moved: 1 } };
const movedHeld: { [key: string]: { moved: number } } = movedSource;
movedHeld.second = { moved: 2 };
const movedAgain = touch(movedHeld);
show(movedAgain === movedHeld, movedHeld, movedSource, [movedAgain, count(movedHeld)]);

const ambientSource = { first: { ambient: 1 } };
const ambientHeld: { [key: string]: { ambient: number } } = ambientSource;
ambientHeld.second = { ambient: 2 };
const ambientAgain: Declared = ambientHeld;
ambientAgain.third = { ambient: 3 };
show(ambientAgain === ambientHeld, ambientHeld, ambientSource, ambientAgain);

const listedSource = { first: { listed: 1 } };
const listedHeld: { [key: string]: { listed: number } } = listedSource;
listedHeld.second = { listed: 2 };
const listedAgain: Listed = listedHeld;
listedAgain.third = { listed: 3 };
show(listedAgain === listedHeld, listedHeld, listedSource, listedAgain);
