const text = "x[object Object]y";
console.log(text.indexOf({}), text.includes({}));
console.log("[object Object]y".startsWith({}), "x[object Object]".endsWith({}));
console.log(text.indexOf({ value: 1 }), text.includes({ value: 2 }));
console.log("plain".indexOf({}), "plain".includes({}));

let trace = "";
function receiver() { trace += "r"; return text; }
function value() { trace += "v"; return 1; }
console.log(receiver().indexOf({ value: value() }), trace);
