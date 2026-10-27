// String and number literals converted to untyped values repeatedly (in
// arrays, object keys and values), including NaN and -0.
function box(x) { return [x]; }
var out = [];
for (var i = 0; i < 3; i++) out.push(box("lit")[0] === "lit", typeof box("x")[0], box("é" + "")[0]);
var o = {}; o["k"] = "v"; var a = ["a", "b"]; a.push("c");
console.log(out.join(","), JSON.stringify(o), a.join("-"), Object.keys({ ["z"]: "lit" }).join());

function box(x) { return [x]; }
var r = [];
for (var i = 0; i < 3; i++) r.push(box(0)[0] + i, box(NaN)[0] === box(NaN)[0], Object.is(box(-0)[0], -0), box(1.5)[0] * 2);
console.log(r.join(","));
