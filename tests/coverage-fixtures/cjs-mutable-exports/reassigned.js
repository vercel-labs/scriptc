// Reassigned after the export: Node's importers keep the first object.
var counter = { n: 1 };
module.exports = counter;
counter = { n: 2 };
