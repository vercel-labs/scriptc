// @requires-libnode
// A sloppy direct eval sees and writes the caller's scope, and the `var`
// it declares lands in the caller's function scope.
const scopes = require("./scopes.js");

console.log(scopes.readsLocal(), scopes.writesLocal());
console.log(scopes.declaresInFunction(), scopes.declaresAtTopLevel());
console.log(scopes.seesArgument("arg"), scopes.repeated());
