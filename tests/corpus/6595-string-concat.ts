// String.prototype.concat converts each argument with ToString, in order.
const base = "dd.internal.entity_id:";
console.log(base.concat("pod-7"));
console.log("a".concat());
console.log("n=".concat(String(1), "+", (2).toString()));
const parts: string[] = ["x", "y"];
console.log("list:".concat(parts[0]!, parts[1]!));
const value: unknown = { toString: () => "custom" };
console.log("obj:".concat(String(value)));
// The receiver and each argument keep the value they had when evaluated,
// before a later argument assigns their variable.
let piece = "a";
console.log("s".concat(piece, ((piece = "b"), "c")), piece);
let head = "r";
console.log(head.concat(((head = "q"), "!")), head);
let at = 1;
console.log("abcdef".substr(at, ((at = 3), 2)), at);
