// A package that runs in a Node island returns node:url's legacy `Url`,
// a type the library declares and the program receives as a live view of
// the island's object. Its member `query` is declared `ParsedUrlQuery`, a
// dictionary with a native representation of its own, which the island's
// object is not: a native read of `u.query` would hand the program a copy,
// so a write through it (`u.query.added = "yes"`) would never reach the
// island's object and `u.query === u.query` would be false, silently. The
// crossing is SC8010 and names the member, as for a record the program
// declares (node-island-view-member).
import { parseLink } from "link-pkg";

const u = parseLink("/path?k=v&k=w", true);
console.log(u.host, u.query);
