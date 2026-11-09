// A record whose field is a dictionary that keeps the object it was given,
// used as a record whose field is a dictionary of another value type: the
// conversion copies the dictionary, so a write through the converted record
// would reach only the copy. Refused at a declaration, at an argument the
// callee writes through, and at an assertion's binding.
type Notes = { [title: string]: { days: number } | string };

const loans = { atlas: { days: 3 } };
const ledger: { [title: string]: { days: number } } = loans;
ledger.almanac = { days: 7 };

const desk: { ledger: { [title: string]: { days: number } } } = { ledger };
const audit: { ledger: Notes } = desk;
audit.ledger.gazette = "lost";

function annotate(shelf: { ledger: Notes }): void {
  shelf.ledger.herbal = "mended";
}
const cart: { ledger: { [title: string]: { days: number } } } = { ledger };
annotate(cart);

const trolley: { ledger: { [title: string]: { days: number } } } = { ledger };
const review = trolley as { ledger: Notes };
review.ledger.primer = "rebound";

console.log(Object.keys(loans).length);
