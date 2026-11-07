// A user override of a schema-building method. The speculative JSON shape
// reads `.int()` from zod's declarations, so a write to a zod member keeps the
// rewrite off for the whole program and every parse goes through zod. The
// override is in a function that is never called: the guard is syntactic, and
// running zod's own methods through an overridden prototype is outside the
// native model. tests/harness/decl-boundary.test.ts compiles this file and
// checks that no helper is generated. The text goes through a `string`
// parameter, as in the case next to it: the planner reads a string-typed
// argument, not a literal.
import { z } from "zod";

function overrideInt(): void {
  z.ZodNumber.prototype.int = function (this: z.ZodNumber): z.ZodNumber {
    return this.max(10);
  };
}

const Row = z.object({ id: z.number().int(), name: z.string() });
const Rows = z.array(Row);

function show(text: string): void {
  const rows = Rows.parse(JSON.parse(text));
  console.log("rows", JSON.stringify(rows));
}

show('[{"id":3,"name":"a"},{"id":4,"name":"b"}]');
console.log("override", typeof overrideInt);
