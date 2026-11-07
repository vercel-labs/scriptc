// @requires-libnode
// Module namespace objects inside an island package: enumerated, compared
// by identity across two importers, inspected, and assigned to. They are
// V8's own (the load plan only tells Node which file a specifier names).
import { assign, describe, setMid, toolKeys, tools } from "nspkg";

console.log(describe());
setMid(9);
console.log(describe());
console.log(assign());
console.log(tools.size, tools.name(), toolKeys());
