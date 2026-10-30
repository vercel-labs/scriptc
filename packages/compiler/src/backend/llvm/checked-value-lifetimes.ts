/** Tests that inspect a tag or scalar payload without invoking user code or
 * refreshing a native view. Object, function, array and Error tests may
 * materialize typed references, so they must keep independent input owners.
 * Keep this list shared by emission and reference-effect inference. */
export function preservesDynTest(test: string): boolean {
  switch (test) {
    case "truthy":
    case "classCapsule":
    case "funcKind":
    case "nullish":
    case "promise":
    case "buffer":
    case "bytes":
    case "bigint":
    case "symbol":
    case "string":
    case "number":
    case "boolean":
    case "undefined":
    case "null":
      return true;
    default:
      return false;
  }
}

/** JSON walkers may invoke getters, toJSON, replacers and revivers. Their
 * runtime ABI borrows every input and owns each returned value; this grants
 * stable-local borrowing only, never reference-edge preservation. */
export function borrowsJsonInputs(fn: string): boolean {
  switch (fn) {
    case "json.parse":
    case "json.parseReviver":
    case "json.stringifyValue":
    case "json.stringifyReplacer":
    case "insp.jsonDyn":
      return true;
    default:
      return false;
  }
}

/** A consumer owns its iterator and captured next method for the whole
 * loop. Runtime steps borrow that state but may invoke indexed getters, so
 * this permits stable-local borrowing without preserving reference edges. */
export function borrowsIteratorInputs(fn: string): boolean {
  return (
    fn === "dyn.iteratorCanStep" ||
    fn === "dyn.iteratorStep" ||
    fn === "dyn.iteratorStepDone" ||
    fn === "dyn.collectionIteratorIndex"
  );
}
