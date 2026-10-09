#pragma once

namespace scriptc {

// `scriptc-llvm-codegen runtime-unit`: emit a runtime-pack unit's object and
// its import bitcode from one optimized module with promoted locals.
int runtimeUnit(int Argc, char **Argv);

} // namespace scriptc
