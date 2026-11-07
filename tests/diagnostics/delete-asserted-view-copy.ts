// A member `delete` through a type assertion names the operand the
// assertions erase to: Node erases `as`, so `(o as View).k` deletes from the
// object `o` names. A key the operand's own layout does not declare lives in
// the record's kept-source view and deletes there (the corpus program
// 8998-delete-undeclared-record-key.ts). A member the operand's type declares
// REQUIRED has no absent state to write, and writing it through the asserted
// view's conversion would delete from a copy instead — dropped without a
// diagnostic — so both positions refuse by name.
interface Params {
  model: string;
}

// An assertion to an OPTIONAL view does not make a required member
// deletable: the operand's own layout holds `model` as a required field,
// which has no absent state to write.
function dropRequiredAsOptional(params: Params): void {
  delete (params as { model?: string }).model;
}

function dropRequiredAsOptionalValue(params: Params): boolean {
  return delete (params as { model?: string }).model;
}

dropRequiredAsOptional({ model: "m" });
console.log(dropRequiredAsOptionalValue({ model: "m" }));
