// A class of an import cycle named where Node never reads it: the arm a
// computed heritage expression does not select (whose condition still
// runs), and an `implements` clause, which names a type. The cycle runs,
// and the class still carries its temporal-dead-zone check at the read
// that does happen.
import { caught, choiceKind, choiceOrder, implKind, lateKind } from "./a.ts";

console.log("caught:", caught);
console.log("choice:", choiceOrder, choiceKind, "impl:", implKind, "late:", lateKind);
