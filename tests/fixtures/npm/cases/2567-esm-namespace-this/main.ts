// A lazily initialized ES module export that reads `this`, called through
// the module's namespace (`lazy.who()`): Node passes the namespace object,
// whose `__esModule` is true. A lowered namespace object would differ, so
// the package stays refused.
import { load } from "gtesmthis";

console.log(load());
