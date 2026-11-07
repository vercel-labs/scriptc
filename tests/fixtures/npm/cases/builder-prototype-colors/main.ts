// A hand-written colour library with the builder shape such libraries
// commonly have (node_modules/tint): every style is a getter on a shared
// prototype made with Object.defineProperties, a builder is a function
// whose prototype is set to it, and an instance comes from a class whose
// constructor returns the factory's function. Compiled natively.
import tint from "tint";

const plain = new tint.Instance({ level: 0 });
const rich = new tint.Instance({ level: 1 });
console.log(JSON.stringify(rich.bold.magenta("Commands:")));
console.log(JSON.stringify(rich.cyan("deploy") + " " + rich.dim("Deploy the project")));
console.log(plain.bold.magenta("Commands:"), plain.underline("https://example.com"));
console.log(typeof rich, typeof rich.bold, rich.bold === rich.bold, rich.level, plain.bold.level);
console.log(JSON.stringify(tint.cyan("default"), null, 0), tint("a", "b"));
rich.level = 0;
console.log(rich.bold("quiet now"), JSON.stringify(new tint.Instance().underline("u")));
