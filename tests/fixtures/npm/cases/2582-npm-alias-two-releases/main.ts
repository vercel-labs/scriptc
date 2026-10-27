// gtroute requires two releases of one package: gtpattern 1.0.0 under its
// own name and 2.0.0 through an npm alias directory (gtpattern-next),
// whose manifest still names gtpattern. Both compile from their own
// JavaScript, as Node loads them.
import { compile } from "gtroute";

console.log(compile("/users/:id"));
