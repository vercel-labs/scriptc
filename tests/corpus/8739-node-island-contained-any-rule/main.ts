// @requires-libnode
// The packages only a Node island loads are in the island set whichever rule
// moved their importer and whether or not a rule ever looked at them. Here
// `outer` is islanded by a refusal in its own module (a class that extends
// Promise), found by lowering. `inner-plain` compiles natively on its own and
// `inner-fenced` only with a fence in its module code; a build used to name
// them only after one more lowering round each, and only because the program
// uses a class of theirs.
import { makeFenced, makePlain, plainInfo, summarize, wait } from "outer";

const plain = makePlain("p");
console.log("class", plain.label, plain.bump(), plain.bump(), plain.count);
const info = plainInfo("i");
info.count += 2;
console.log("record", info.label, info.count);
const fenced = makeFenced("f");
console.log("fenced", fenced.label, fenced.bump(), fenced.probe);
console.log("back into the island", summarize(plain, fenced, info));
void wait(5).then((value) => console.log("waited", value));
