/* Parallel loops (@scriptc/experimental): the par.* intrinsics
 * (scr_parallel.c, frontend/lowering/parallel-loops.ts).
 *
 * The frontend has already decided everything the runtime needs: the
 * element count (`count`, or the target and its stride), the chunk plan
 * (`grainGiven` says whether `grain` is the program's option or the
 * default the frontend computed), and whether the body passed the effect
 * check (the `parallel` flag, 1 or 0). The runtime validates the numbers,
 * builds the chunks' views and calls the body; a call it rejects throws
 * into the caller's pending check with the message the Node implementation
 * gives.
 *
 * Every operand is evaluated once, left to right, and owned by this
 * statement's frame: the runtime neither retains nor releases any of them,
 * and a body the program wrote may reassign a captured binding, which
 * would free a value borrowed across the call. The closures it calls are
 * therefore the ordinary heap closures (scr_closure_new) whose `fn` field
 * the runtime enters with the closure as the environment, and the typed
 * arrays the body reads are one NULL-terminated array of the same
 * ownership.
 *
 * A Worker program's threads have no runtime state of their own, so none
 * of them can run a chunk beside the caller: `parallel` is 0 there and the
 * chunks run one after another on the calling thread. */
import { InternalCompilerError } from "../../errors.js";
import { f64Lit } from "./common.js";
import type { ExprOf, LlValue, LlvmEmitterContext } from "./expr-context.js";

/** The par.* intrinsics. */
export function emitParallelIntrinsic(host: LlvmEmitterContext, e: ExprOf<"intrinsic">): LlValue {
  const B = host.B;
  const args = e.args.map((arg) => host.emitExpr(arg));
  if (B.isTerminated()) return { name: "", type: e.type };
  /** The number operand `index`, or a compile error when the frontend built
   * the call with another type. */
  const number = (index: number): string => {
    const arg = args[index];
    if (arg === undefined || host.llType(arg.type) !== "double")
      throw new InternalCompilerError(
        `llvm emitter bug: ${e.name} operand ${index} is not a number`,
      );
    return arg.name;
  };
  /** The reference operand `index` (a typed array, a closure). */
  const reference = (index: number): string => {
    const arg = args[index];
    if (arg === undefined || host.llType(arg.type) !== "ptr")
      throw new InternalCompilerError(
        `llvm emitter bug: ${e.name} operand ${index} is not a reference`,
      );
    return arg.name;
  };
  // A Worker program's helper threads hold none of the runtime's state, so
  // the chunks always run on the calling thread there. The flag is the last
  // number the frontend passes before the callbacks.
  const parallelAt = e.name === "par.for" ? 3 : 4;
  const parallel = host.mod.workers === true ? f64Lit(0) : number(parallelAt);
  switch (e.name) {
    case "par.into": {
      if (args.length < 6) throw new InternalCompilerError("llvm emitter bug: par.into operands");
      // The typed arrays the body reads, as the runtime's array argument.
      const reads = args.slice(6).map((arg, index) => reference(index + 6));
      const size = host.sizeType;
      host.declare(
        `declare void @scr_par_into(ptr, double, double, double, double, ptr, ptr, ${size})`,
      );
      let lists = `ptr null, ${size} 0`;
      if (reads.length > 0) {
        const list = B.slot();
        B.entryAllocas.push(`${list} = alloca [${reads.length} x ptr]`);
        reads.forEach((read, index) => {
          const at = B.tmp();
          B.line(
            `${at} = getelementptr inbounds [${reads.length} x ptr], ptr ${list}, ${size} 0, ${size} ${index}`,
          );
          B.line(`store ptr ${read}, ptr ${at}`);
        });
        lists = `ptr ${list}, ${size} ${reads.length}`;
      }
      B.line(
        `call void @scr_par_into(ptr ${reference(0)}, double ${number(1)}, double ${number(2)}, double ${number(3)}, double ${parallel}, ptr ${reference(5)}, ${lists})`,
      );
      host.emitPendingCheck();
      return { name: "", type: e.type };
    }
    case "par.reduce": {
      if (args.length !== 7)
        throw new InternalCompilerError("llvm emitter bug: par.reduce operands");
      host.declare(
        `declare double @scr_par_reduce(double, double, double, double, double, ptr, ptr)`,
      );
      const result = B.tmp();
      B.line(
        `${result} = call double @scr_par_reduce(double ${number(0)}, double ${number(1)}, double ${number(2)}, double ${number(3)}, double ${parallel}, ptr ${reference(5)}, ptr ${reference(6)})`,
      );
      host.emitPendingCheck({ name: result, type: e.type });
      return { name: result, type: e.type };
    }
    case "par.for": {
      if (args.length !== 5) throw new InternalCompilerError("llvm emitter bug: par.for operands");
      host.declare(`declare void @scr_par_for(double, double, double, double, ptr)`);
      B.line(
        `call void @scr_par_for(double ${number(0)}, double ${number(1)}, double ${number(2)}, double ${parallel}, ptr ${reference(4)})`,
      );
      host.emitPendingCheck();
      return { name: "", type: e.type };
    }
    default:
      throw new InternalCompilerError(`llvm emitter bug: unknown intrinsic ${e.name}`);
  }
}
