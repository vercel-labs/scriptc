// The remaining loop-head forms: pre-declared identifier heads over
// STRING iterables (code-point walk, value persists after the loop), and
// `var` PATTERN declarators in plain for-loop initializers (hoisted-slot
// assignments through the declaration desugar — several declarators
// compose; let/const pattern heads are 8602).
var v = "";
for (v of ["hello", "hi"]) console.log(v);
for (v of "héllo") console.log(v);
console.log("after", v);
for (var {} = {}, {} = {}; false; void 0) { }
var oa = 0; var ob = "";
for (var { na: oa = 5 } = {} as { na?: number }, [ob = "s"] = [] as string[]; oa < 7; oa++) console.log(oa, ob);
console.log("done");
