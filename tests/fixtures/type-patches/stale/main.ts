import ms from "ms";
import { Terminal } from "termctx";

console.log(ms(1000), new Terminal(true).columns());
