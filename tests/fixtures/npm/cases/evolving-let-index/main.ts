// Reads of a `let` binding whose checker type comes from string index reads
// see undefined past the end.
import { countUntilBracket, skipSpaces } from "evolving-let";
console.log(skipSpaces("ab  ", 2), skipSpaces("a b", 1), countUntilBracket("abc"), countUntilBracket("ab]c"));
