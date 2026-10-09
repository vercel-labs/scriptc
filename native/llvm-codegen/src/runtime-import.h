#pragma once

#include "llvm/IR/Module.h"

#include <optional>
#include <string>
#include <vector>

namespace scriptc {

// Makes small runtime functions visible to the program optimizer. Each input
// is LLVM bitcode for a runtime-pack unit that is also linked as a native
// object (both are emitted from one module by `runtime-unit`, which promotes
// unit-local symbols to hidden unit-qualified globals). Selected external
// definitions are linked into the program module as available_externally,
// exactly like ThinLTO function import: the optimizer may inline or
// specialize them, and every remaining reference resolves to the runtime
// object at link time. Selection starts at the runtime functions the
// program declares and follows calls with a size limit that decays per hop.
// Bodies that would need a second copy of unit-local state or a second
// address for a local function (possible only with unpromoted bitcode) are
// never imported.
//
// Returns an error message on failure.
std::optional<std::string>
importRuntimeBitcode(llvm::Module &Program,
                     const std::vector<std::string> &BitcodePaths);

} // namespace scriptc
