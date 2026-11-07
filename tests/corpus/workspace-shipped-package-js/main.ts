// A workspace-linked package answered by declarations and JavaScript keeps
// the installed-package rule: its JavaScript is the package's shipped code,
// typed by the declarations, while an entry that imports it runs as before.
import { greet, value } from "wsshipped";

console.log(`value ${value}`);
console.log(greet("shipped"));
