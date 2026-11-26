import { requireModule } from "@scriptc/node";
import { EventEmitter, errorMonitor } from "node:events";

const island = requireModule("./error-brand.cjs");
const emitter = new EventEmitter();
emitter.on(errorMonitor, () => island.detach(island.kept()));
try {
  island.fail();
} catch (seen) {
  try {
    emitter.emit("error", seen as Error);
  } catch (wrapped) {
    const error = wrapped as any;
    console.log(error.code, island.same(error.context), island.same(error));
  }
}
