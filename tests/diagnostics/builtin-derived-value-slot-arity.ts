// A builtin function value derived from its direct call takes the arguments
// that call lowers and no more. Node's function reads further ones
// (mkdtemp's options, realpath's encoding), and a slot converts a function
// with fewer parameters by dropping the extra arguments, so the value in a
// slot that passes them would silently ignore what Node honours. Such a slot
// is the direct call with those arguments, which has no lowering, and an
// untyped slot bounds nothing a call passes: both refuse by name.
import { mkdtemp, realpath, stat } from "node:fs/promises";

type Maker = (prefix: string, options: { encoding: "hex" }) => Promise<string>;
async function make(fn: Maker, prefix: string): Promise<string> {
  return fn(prefix, { encoding: "hex" });
}
const viaParameter = await make(mkdtemp, "scriptc-");
const viaField: { resolve?: (path: string, encoding: "hex") => Promise<string> } = {
  resolve: realpath,
};
const untyped: unknown = stat;
console.log(viaParameter, viaField, untyped);
