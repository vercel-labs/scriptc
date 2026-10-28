#pragma once

namespace llvm {
class Module;
}

namespace scriptc {

// Removes reference-count pairs the emitter's expression lowering leaves:
// a retain of a value whose only other uses borrow it, released on every
// path, while something else provably keeps the value alive (a local slot
// that still holds it, or no call or release at all in between). Runs on
// the module as emitted, before the retain and release helpers are inlined.
// Returns the number of pairs removed.
unsigned removeRcPairs(llvm::Module &M);

} // namespace scriptc
