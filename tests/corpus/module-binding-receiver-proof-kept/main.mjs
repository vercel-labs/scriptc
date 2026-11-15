// Module exports called through their module binding, each held in a form
// the receiver proof follows and none reading `this`: Node passes the
// namespace as the receiver, nobody reads it, and the direct call agrees.
import * as lib from "./lib.mjs";

console.log(lib.viaNamespaceFactory(1));
console.log(lib.viaAliasedFactory(2));
console.log(lib.namespaceMember(3));
console.log(lib.sized(4), lib.sized.length);
console.log(lib.tagged(5), lib.tagged.tag);
console.log(lib.frozen(6), Object.isFrozen(lib.frozen));
console.log(lib.eitherArm(7));
console.log(lib.afterComma(8));
console.log(lib.fallback(9), lib.either(10));
console.log(lib.neverAssignedAgain(11));
console.log(lib.reexported(12));
console.log(lib.default(13));
console.log(lib.bound(14), lib.boundByName(15));
console.log(lib.methodsNamedCall(16));
console.log(lib.throughPrototype(17));
console.log(lib.isList([18]), lib.fromBuilt(19));
console.log(lib.assignedAgain(20));
console.log(lib.chosen(21), lib.fromWritten(22));
