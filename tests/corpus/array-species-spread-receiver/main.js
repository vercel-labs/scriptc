// An Array subclass anywhere in the program routes array-method calls through
// ArraySpeciesCreate, which stages the receiver into a hidden local. A module
// whose array spread reads such a staged receiver must initialize it even when
// the method itself lowers through the value's checked-dynamic view.
import { bagTotal } from "./dep.js";

console.log("main", bagTotal());
