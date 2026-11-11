// Node APIs scriptc's declarations name but its lowering does not answer:
// each use below type-checks and is then refused by name (SC2020). The
// compatibility ledger cites this program for marking the rows a verified
// absence instead of an unverified registry gap.

// console: the stack-printing member.
console.trace("where");

// The global MessageChannel and its ports.
const channel = new MessageChannel();
channel.port1.postMessage("x");
channel.port2.close();
