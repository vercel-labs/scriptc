// A builtin class constructed through the dynamic handle path: the
// `.constructor` read and the construction both run the constructor hook
// the compiler installs for the program (the base hook), which must keep
// answering the class Node names.
const error = new DOMException("stopped", "AbortError");
console.log("domex " + error.constructor.name + " " + error.name + " " + error.message);
const plain = new Error("plain");
console.log("error " + plain.constructor.name + " " + plain.message);
const date = new Date(86400000);
console.log("date " + date.constructor.name + " " + date.toISOString());
