// @requires-libnode
// An installed package that scriptc cannot compile natively (its JavaScript
// holds a class expression with a static initializer outside a
// whole-initializer position) and whose declarations name a Node type the
// bundled Node declarations do not spell (NodeJS.Platform). The package must
// run in a Node island and answer both exports: a declaration error inside an
// installed package is the package's own tsconfig's business, not a reason to
// drop the island and fail the program natively. Node and the island read the
// same package sources, so the answers are the package's own.
import { platform, tag } from "platform-probe";

console.log(tag());
console.log(platform);
