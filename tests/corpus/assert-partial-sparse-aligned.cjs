const assert = require("node:assert");
function show(name, f) { try { f(); console.log(name, "pass"); } catch (e) { console.log(name, "throw", e.name); } }
function sparseA() { const a = []; a.length = 2; a[1] = undefined; return a; }
function sparseB() { const b = [undefined]; b.length = 2; return b; }
show("sparsePartial", () => assert.partialDeepStrictEqual(sparseA(), sparseB()));
show("holeVsValue", () => assert.partialDeepStrictEqual(sparseA(), [1, undefined]));
show("plain", () => assert.partialDeepStrictEqual([1, 2, 3], [1, 3]));
