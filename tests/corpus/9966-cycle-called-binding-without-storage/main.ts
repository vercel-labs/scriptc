// A module-level constant that holds a promisified library function, in a
// module of an import cycle, in a program whose graph also holds a CommonJS
// package. Every reference to the constant is a call. Each call checks that
// the declaration ran: reached earlier, it throws the ReferenceError Node
// throws, naming the binding as the calling module spells it; afterwards the
// calls run as usual.
import { perCrate } from "crate-units";
import { summarize } from "./ledger.ts";
import { later } from "./layout.ts";

const stock = import.meta.dirname + "/stock.txt";
console.log(perCrate, await summarize(stock));
console.log(await later(stock));
