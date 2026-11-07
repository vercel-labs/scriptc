// A member `delete` through an assertion addresses the operand, and the
// other erased wrappers around or under the assertion do not change that
// (tests/corpus/8826-delete-erased-wrappers.ts). A view that names a member
// the operand's own layout does not hold still has nothing to delete, so it
// is refused by name through every wrapper, in both positions, instead of
// deleting from the assertion's converted copy.
interface Params {
  model: string;
}
type Wide = { model: string; max_tokens?: number };

function dropUnderNonNull(params: Params): void {
  delete (params as Wide)!.max_tokens;
}

function dropUnderSatisfies(params: Params): boolean {
  return delete ((params as Wide) satisfies Wide).max_tokens;
}

function dropThroughAny(params: Params): void {
  delete (params as any).max_tokens;
}

// An operand that may be undefined names the same layout once it is there.
function dropFromOptional(params: Params | undefined): void {
  delete (params as Wide).max_tokens;
}

// A required member stays undeletable through the wrappers.
function dropRequired(params: Params | undefined): void {
  delete (params as { model?: string })!.model;
}

// An optional chain answers `true` for a nullish value; the in-place delete
// narrows the value with a check instead, so the combination is refused.
function dropThroughChain(params: { model?: string } | undefined): boolean {
  return delete (params as { model?: string; extra?: number })?.model;
}

dropUnderNonNull({ model: "m" });
console.log(dropUnderSatisfies({ model: "m" }));
dropThroughAny({ model: "m" });
dropFromOptional({ model: "m" });
dropRequired({ model: "m" });
console.log(dropThroughChain(undefined));
