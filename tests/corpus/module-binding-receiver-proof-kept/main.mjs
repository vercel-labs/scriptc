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
