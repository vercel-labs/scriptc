// A program buffer that can move, shrink or go away has no fixed memory for
// an island's view to stand on (node-island-handles.test.ts): its crossing
// is refused by name, as a value or through a view, while a buffer of fixed
// length crosses. Under Node every line answers a size.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./movable-buffers.cjs");

function attempt(label, value) {
  try {
    console.log(label, lib.size(value));
  } catch (error) {
    console.log(label, error instanceof TypeError, error.message);
  }
}

attempt("fixed view", new Uint8Array(new ArrayBuffer(8)));
attempt("fixed buffer", new ArrayBuffer(8));
const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
attempt("resizable view", new Uint8Array(resizable));
attempt("resizable buffer", resizable);
const gone = new ArrayBuffer(8);
gone.transfer();
attempt("detached buffer", gone);
