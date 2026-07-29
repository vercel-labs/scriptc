// @dynamic
// A dual package whose "module" ESM arm exposes a value only through a
// named re-export. Node loads the equivalent "main" CJS arm; scriptc
// deliberately prefers the ESM arm and must classify each relative leaf
// with Node 24 syntax detection: real ESM leaves stay native while nested,
// explicit-extension, and same-scope CommonJS boundaries keep their facade.
import {
  CJS_VALUE,
  EXPLICIT_VALUE,
  SAME_SCOPE_CJS_VALUE,
  VALUE,
} from "esm-named-reexport";

console.log(
  `VALUE = ${VALUE}; CJS_VALUE = ${CJS_VALUE}; ` +
  `EXPLICIT_VALUE = ${EXPLICIT_VALUE}; SAME_SCOPE_CJS_VALUE = ${SAME_SCOPE_CJS_VALUE}`,
);
