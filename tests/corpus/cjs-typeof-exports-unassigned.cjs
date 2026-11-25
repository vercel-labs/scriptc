// A CommonJS module that assigns no member of `exports` still has the
// exports object: `typeof exports` is "object" wherever it is asked, so the
// module-system test of a universal module definition takes the CommonJS
// arm.
const show = (label, value) => console.log(label, value);
show("typeof exports", typeof exports);
show("typeof module", typeof module);
show("typeof require", typeof require);
show("exports is module.exports", exports === module.exports);
console.log(typeof exports === "object" && typeof module !== "undefined" ? "commonjs" : "global");
console.log(typeof exports !== "undefined" ? "has exports" : "no exports");
console.log(typeof exports === "undefined", typeof exports == "object", typeof exports < "u");

function kinds() {
  return [typeof exports, typeof module, typeof require, typeof __filename, typeof __dirname];
}
console.log(kinds().join(" "));
const absent = () => typeof exports === "undefined";
console.log(absent(), typeof define === "function", typeof window);

let system = "none";
if (typeof exports === "object") system = "commonjs";
else if (typeof define === "function") system = "amd";
console.log(system);
