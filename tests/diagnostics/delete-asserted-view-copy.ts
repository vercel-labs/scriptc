// A member `delete` through a type assertion names the operand the
// assertions erase to: Node erases `as`, so `(o as View).k` deletes from the
// object `o` names. A view that declares a member the value's own layout does
// not hold has no slot to delete, and lowering the asserted expression would
// delete from the assertion's converted copy instead — dropped without a
// diagnostic. The delete is refused by name in both positions.
interface Params {
  model: string;
}

function dropAddedOptional(params: Params): void {
  delete (params as { model: string; max_tokens?: number }).max_tokens;
}

function dropAddedOptionalValue(params: Params): boolean {
  return delete (params as { model: string; max_tokens?: number }).max_tokens;
}

// The `as unknown` link does not make the delete dynamic either: the chain
// still names the value's own layout, which has no slot for `extra`.
function dropThroughUnknown(bag: { a: number }): void {
  delete (bag as unknown as { a: number; extra?: string }).extra;
}

// An assertion to an OPTIONAL view does not make a required member
// deletable: the operand's own layout holds `model` as a required field,
// which has no absent state to write.
function dropRequiredAsOptional(params: Params): void {
  delete (params as { model?: string }).model;
}

dropAddedOptional({ model: "m" });
console.log(dropAddedOptionalValue({ model: "m" }));
dropThroughUnknown({ a: 1 });
dropRequiredAsOptional({ model: "m" });
