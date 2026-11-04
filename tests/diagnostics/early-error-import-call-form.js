// import() takes an AssignmentExpression and an optional options object, and
// import.defer() takes exactly one AssignmentExpression. TypeScript reports
// the wrong arity as a message-category diagnostic the compiler does not keep
// as an error, so the grammar check is the compiler's own early error.
import();
import("./mod.js", {}, {});
import.defer();
import.defer("./mod.js", {});
