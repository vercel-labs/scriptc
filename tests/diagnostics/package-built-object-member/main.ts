// The package's JavaScript builds `{ id, amount }`; its declarations also
// promise an optional `note`. The object the compiled code hands over has no
// place for a member its code never creates, so a write or a read of it is
// refused by name. A member the code does build writes in place.
import { makeEntry } from "shelf-kit";

const entry = makeEntry("e1");
entry.amount = 2;
entry.note = "checked";
console.log(entry.amount, entry.note);
