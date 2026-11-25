import { requireModule } from "@scriptc/node";

const island = requireModule("./error-brand.cjs");
const result: unknown = island.kept();
const typed = result as Error;
const nullable = result as Error | null;
console.log("cast", typed === result, nullable === result, island.same(typed));
try {
  island.fail();
} catch (caught) {
  console.log("catch", caught === result, caught instanceof TypeError);
}
const guarded: unknown = island.error(false);
console.log("callback", island.callWith((v: unknown) => v === guarded, guarded), island.reads());
try {
  await island.reject();
} catch (caught) {
  console.log("reject", caught === result);
}
island.detach(typed);
console.log("detached", Error.isError(typed), typed instanceof Error, typed instanceof TypeError);
