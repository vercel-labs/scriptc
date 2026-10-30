#pragma once

#include "llvm/ADT/ArrayRef.h"
#include "llvm/ADT/StringRef.h"
#include "llvm/ADT/StringSet.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace scriptc {

// A program module divided into independently compilable textual modules.
struct ProgramPartitions {
  // One complete LLVM assembly module per partition.
  std::vector<std::string> Sources;
  // Definitions that were not internal in the original module. Every other
  // definition was internal, and is promoted to hidden visibility only when
  // another partition references it.
  llvm::StringSet<> PublicSymbols;
  // The bytes of the function definitions placed in each partition.
  std::vector<uint64_t> FunctionBytes;
};

// Divides the LLVM assembly scriptc emits into Count modules without parsing
// it, so the partitions can be parsed concurrently. In modules of 32 or
// more partitions, functions under a "; scriptc-group <key>" line are placed
// with the other functions of that source-module group, which is divided
// into chunks when it is larger than the mean partition or 1 MiB; other
// functions are placed by a stable hash of their name. An internal
// definition referenced by exactly one other definition stays with it, also
// through a global, unless it is a function whose body is too large to
// inline, that would leave its source-module group for a function outside
// every group, or, in a module of more than 1 MiB, that would join a function
// of another source-module group; a global otherwise stays with the first
// function that references it.
// Internal definitions that no non-internal definition, named metadata or
// metadata node reaches are left out of every partition. Returns nullopt
// for any construct outside the emitter's narrow top-level grammar; callers
// then split a parsed module. With SkipDominated, a division that
// dominatedPartitions rejects has no Sources.
std::optional<ProgramPartitions> partitionProgramText(llvm::StringRef Text,
                                                      unsigned Count,
                                                      bool SkipDominated);

// Whether the largest partition would hold more than two thirds of the
// program's function bytes.
bool dominatedPartitions(llvm::ArrayRef<uint64_t> FunctionBytes);

} // namespace scriptc
