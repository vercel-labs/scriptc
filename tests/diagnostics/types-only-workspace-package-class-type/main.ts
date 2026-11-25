// A class a declarations-only package declares with a constructor and a
// method is a value shape: only an implementation could make an instance,
// and there is none. Used as a type it stays refused by name, at each slot
// typed with it, while the interface from the same package types a record
// the program builds.
import type { Book, Stamp } from "lending-types";

const book: Book = { isbn: "0-1", title: "Tides" };
function mark(stamp: Stamp): string {
  return stamp.ink + " " + stamp.press();
}
const stamp: Stamp = {
  ink: "red",
  press() {
    return "pressed";
  },
};
console.log(book.title, mark(stamp));
