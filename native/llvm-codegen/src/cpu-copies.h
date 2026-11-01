#pragma once

#include "llvm/IR/Module.h"

namespace scriptc {

// The string attribute that marks the x86-64-v3 copies of a `--cpu-dispatch`
// or `--target-cpu=x86-64-v3` build. The compiler names a function's copies
// `<name>.base` and `<name>.v3`; the thin link may rename either to
// `<copy>.llvm.<n>`.
inline constexpr const char *CpuCopyAttribute = "scriptc-cpu-copy";

// Runs after optimization, before code generation. An x86-64-v3 copy whose
// optimized body has vectors of at most 128 bits takes the optimized body of
// its baseline copy instead, unless it has something else the baseline
// compiles to slower code: a vector wider than 128 bits, or a rounding or
// bit-count intrinsic in a loop. In 128-bit vector code the higher level
// only adds instructions that the vectorizers prefer over scalar ones, and
// these can run slower. Scalar code keeps its x86-64-v3 code. The copy keeps
// its name, so its callers do not change, and the body's direct calls to
// baseline copies call their x86-64-v3 copies, so that callees still run at
// the level the executable chose.
//
// A copy is left as it is when its baseline copy is not defined in the
// module, the two copies' types differ, the profile gives the baseline copy
// fewer runs (its body is then optimized as colder code), or the baseline
// copy calls a function the module defines for another CPU level. In a
// `--target-cpu=x86-64-v3` build, functions without copies are x86-64-v3
// code, which the optimizer does not inline into baseline copies. Every copy
// is left as it is in a module that counts executions for a profile.
void useBaselineBodies(llvm::Module &M);

} // namespace scriptc
