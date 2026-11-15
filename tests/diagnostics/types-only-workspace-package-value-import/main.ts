// A workspace package that ships only declarations has no implementation, so
// an import that needs a VALUE from it (a class to construct, an enum object,
// a constant, a function) is refused by name. Node ends the same program at
// start: nothing it could load exports these names. The interface beside
// them is only a type and would compile from an `import type`.
import { EDITION, Floor, Stamp, bind } from "lending-types";
import type { Book } from "lending-types";

const book: Book = bind("0-1");
const stamp = new Stamp(EDITION);
console.log(book.title, stamp.press(), stamp instanceof Stamp, Floor.Upper);
