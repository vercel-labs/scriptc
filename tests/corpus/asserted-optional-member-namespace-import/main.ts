// A namespace import whose member names another module's asserted-view
// binding (`data.view`): the checker types the access at the exported
// assertion, while the value is the record the exporter stored. The added
// member reads off that record's kept source, exactly as a local binding
// does, through the plain read, the optional chain and parentheses.
import * as data from "./data.ts";
import { view as namedView } from "./data.ts";

console.log("ns", String(data.view.icons), data.view.name);
console.log("ns-chain", String(data.view?.icons));
console.log("ns-paren", String((data.view).icons), String((data.view)?.icons));
console.log("ns-missing", String(data.bare.icons), String(data.bare?.icons));
console.log("named", String(namedView.icons), namedView.name);
console.log("ns-object", Object.keys(data.view).join(","), JSON.stringify(data.view));
