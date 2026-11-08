// A module's constant tables reached through a namespace import. The
// namespace is only asked for members, so each table it reaches is named at
// the site and takes the layout of the type it is read through: the table a
// reader holds is the table the module exports.

import * as birds from "./birds.ts";
import { heron, housed, type Bird } from "./birds.ts";

birds.admit(birds.heron);
birds.admit(birds.wren);

// Through the namespace and by name: one object.
console.log(birds.housed(birds.heron), housed(heron), birds.housed(birds.wren), birds.census());
console.log(birds.housed(birds.swift), birds.heron === heron);

// A table named by another, read through the namespace.
console.log(birds.heron.mate === birds.wren, birds.housed(birds.heron.mate), birds.heron.mate.name);

// Members the interface makes optional are present in the literal's type.
console.log(birds.heron.wingspan + birds.swift.wingspan, birds.wren.name.length);

// A list that holds what the namespace hands out.
const seen: Bird[] = [birds.swift, birds.heron];
console.log(seen.includes(heron), seen.indexOf(birds.swift), seen[1] === heron);

// A function that holds a table as its interface hands back the same object.
function mateOf(bird: Bird): Bird | undefined {
  return bird.mate;
}
console.log(mateOf(birds.heron) === birds.wren, mateOf(birds.swift) === undefined);
console.log(Object.keys(birds.swift).join(), JSON.stringify(birds.heron));
