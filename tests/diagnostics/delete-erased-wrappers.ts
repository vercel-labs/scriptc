// A member `delete` through an assertion addresses the operand, and the
// other erased wrappers around or under the assertion do not change that
// (tests/corpus/8826-delete-erased-wrappers.ts). A key the operand's own
// layout does not declare is removed from the record's kept source through
// every wrapper (the same corpus program). What the operand cannot delete in
// place stays refused by name through the wrappers, in both positions,
// instead of deleting from the assertion's converted copy.
interface Params {
  model: string;
}

// A required member stays undeletable through the wrappers.
function dropRequired(params: Params | undefined): void {
  delete (params as { model?: string })!.model;
}

function dropRequiredUnderSatisfies(params: Params): boolean {
  return delete ((params as { model?: string }) satisfies { model?: string }).model;
}

// A key that is another record's declared field: `copy` is a second record
// built from `wide`, and the delete cannot reach `wide.k` through it
// (tests/diagnostics/delete-source-field.ts), whatever wraps the assertion.
type Wide = { x: number; k: number };
type Narrow = { x: number };
const wide: Wide = { x: 1, k: 2 };
const copy: Narrow = wide;
console.log(delete (copy as Narrow & { k?: number })!.k, wide.k);

function dropFromOptionalCopy(narrow: Narrow | undefined): void {
  delete (narrow as Narrow & { k?: number }).k;
}

// An optional chain answers `true` for a nullish value; the in-place delete
// narrows the value with a check instead, so the combination is refused.
function dropThroughChain(params: { model?: string } | undefined): boolean {
  return delete (params as { model?: string; extra?: number })?.model;
}

dropRequired({ model: "m" });
console.log(dropRequiredUnderSatisfies({ model: "m" }));
dropFromOptionalCopy(copy);
console.log(dropThroughChain(undefined));
