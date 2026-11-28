// A database's inspection has a stable identity: a value that points back
// to the database through its metadata is Node's circular reference at any
// depth (including depth: null, where an unbounded walk would otherwise
// recurse forever), and a bounded depth still prints the cycle rather than
// the bracketed class name.
const util = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const self = new DatabaseSync(":memory:");
self.self = self;
console.log("self-default", util.inspect(self));
console.log("self-0", util.inspect(self, { depth: 0 }));
console.log("self-1", util.inspect(self, { depth: 1 }));
console.log("self-null", util.inspect(self, { depth: null }));
const plain = new DatabaseSync(":memory:");
plain.label = "x";
console.log("plain-0", util.inspect(plain, { depth: 0 }));
console.log("plain-null", util.inspect(plain, { depth: null }));
const stmt = self.prepare("SELECT 1 AS n");
console.log("stmt", util.inspect(stmt, { depth: null }));
console.log("db-with-stmt", util.inspect(self, { depth: null }));
stmt.all();
// The untraced self-reference would keep the database alive past the audit
// (a separate, documented cycle); the inspection above has already run.
self.self = null;
self.close();
plain.close();
