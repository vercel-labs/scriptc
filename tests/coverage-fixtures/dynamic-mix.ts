// Native checked values and loose equality share this program with
// island-backed APIs (SC2012) and explicit island evaluation (SC2010).
const v: any = 21;
const doubled = v * 2;
const root = Math.cbrt(81);
const up = (19.99).toPrecision(3);
const parsed = Number.parseFloat("1.5"); // a string argument compiles statically, like the global
const raw = __island_eval("6 * 7");
const unknownScore: unknown = 81;
const flags = unknownScore == 81;
console.log("done");
