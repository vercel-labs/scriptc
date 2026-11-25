// util.inspect of RegExp values: the pattern and flags print with the
// pattern styled red on its own, while a showHidden render lists the own
// `[lastIndex]` entry (yellow under colors) and leaves the base plain —
// Node styles the base only on its early return. lastIndex follows exec.
// The entries follow index-like keys, respect the depth budget by dropping
// them entirely, and %o is the showHidden walk.
import * as util from "node:util";

const show = (label: string, value: any, options?: any): void => {
  console.log(`${label}: ${util.inspect(value, options)}`);
};

show("plain", /a.c/gi);
show("empty pattern", /(?:)/);
show("flags", /x/gimsuy);
show("escaped", /a\/b\n/);
show("source only", new RegExp("a+b"));

const re = /a.c/gi;
show("hidden", re, { showHidden: true });
re.lastIndex = 2;
show("moved", re, { showHidden: true });
re.exec("xxabc");
show("exec", re, { showHidden: true });
show("hidden legacy flag", re, true);
show("plain after exec", re);

show("nested", { re }, { showHidden: true });
show("nested depth1", { re }, { showHidden: true, depth: 1 });
show("nested depth0", { re }, { showHidden: true, depth: 0 });
show("in array", [/x/g, "s"], { showHidden: true });
show("in map", new Map<string, any>([["r", /x/g]]), { showHidden: true });

show("colors plain", /x/g, { colors: true });
show("colors hidden", /x/g, { colors: true, showHidden: true });
show("colors nested", { r: /x/g }, { colors: true });

console.log(`format o: ${util.format("%o", /x/g)}`);
console.log(`format O: ${util.format("%O", /x/g)}`);
console.log(`formatWithOptions: ${util.formatWithOptions({ showHidden: true }, "%o", /x/g)}`);
console.log(`format colors: ${util.formatWithOptions({ colors: true }, "%o", /x/g)}`);
