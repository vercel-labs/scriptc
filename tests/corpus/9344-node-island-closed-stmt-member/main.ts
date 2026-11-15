// @requires-libnode
// An island-closed statement that changes a data member of the package's
// export. A deferred module's data members are answered from the build's
// snapshot without Node, and the snapshot was taken when the package
// loaded: so the build keeps both the package and the statement where the
// program has them, and each read sees the calls before it.
import { registry } from "plug-kit";

console.log("size", registry.size);
registry.grow();
console.log("size", registry.size);
registry.grow();
registry.grow();
console.log("size", registry.size);
