// util.inspect of Array subclass instances: the `Name(length)` prefix, and
// the `[Name]` placeholder past the depth limit, plain and with colors.
import { inspect } from "node:util";

class Scores extends Array<number> {}

const s = new Scores();
s.push(1, 2);
console.log(inspect(new Scores()), inspect(s));
console.log(inspect([s], { depth: 0 }), inspect([[1]], { depth: 0 }));
console.log(JSON.stringify(inspect([s], { depth: 0, colors: true })));
console.log(JSON.stringify(inspect([[1]], { depth: 0, colors: true })));
console.log(JSON.stringify(inspect(s, { colors: true })));
