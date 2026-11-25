// `await` is a ReservedWord where the grammar passes [Await] down (an async
// function's body and parameters, a class static block, a module's top
// level). tsc accepts the arrow-parameter and static-block spellings, so the
// early-error pass owns the rule; Node refuses each program.
class Pending {
  static {
    // @ts-expect-error -- the compiler's own early error fires first
    ((x = await) => 0);
  }
}
const pending = async () => {
  // @ts-expect-error -- the compiler's own early error fires first
  (a = await) => 0;
};
pending();
new Pending();
