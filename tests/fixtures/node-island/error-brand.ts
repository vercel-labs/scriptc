import { requireModule } from "@scriptc/node";

const island = requireModule("./error-brand.cjs");
function brand(value: unknown): boolean {
  return Error.isError(value);
}
console.log(
  brand(island.error(false)),
  brand(island.error(true)),
  brand(island.prototypeOnly()),
  brand(island.lookalike()),
  island.reads(),
);
