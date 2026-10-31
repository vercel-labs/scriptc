#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace llvm {
class Module;
class TargetMachine;
} // namespace llvm

namespace scriptc {

struct EmitOptions {
  std::string Input;
  // One output per program partition; several require object output.
  std::vector<std::string> Outputs;
  std::string FileType = "obj";
  std::string Target;
  std::string OptLevel = "2";
  std::string RelocationModel = "pic";
  std::string DiagnosticFormat = "json";
  std::string SourcePath;
  // Runtime bitcode whose small functions are imported available_externally.
  std::vector<std::string> ImportBitcode;
  // Private directory for reusable partition artifacts; empty disables reuse.
  std::string CacheDirectory;
  // Instruments the program for IR profiling. The instrumented executable
  // writes raw profiles to this path pattern (LLVM_PROFILE_FILE overrides it
  // at run time). Empty: no instrumentation. With ProfileUse, the program is
  // optimized by that profile and instrumented again after inlining, which
  // records context-sensitive counts.
  std::string ProfileGenerate;
  // Indexed profile (.profdata) that guides optimization. Empty: none.
  std::string ProfileUse;
  // With ProfileUse: block counts (profile-blocks.h) that annotate the
  // functions whose control flow changed since the profile was collected.
  // Empty: none.
  std::string ProfileBlocks;
  // With ProfileUse: writes the block counts of the functions the profile
  // annotates to this path. Empty: none.
  std::string RecordProfileBlocks;
  // With several outputs: optimize the module whole and divide only its code
  // generation among the outputs.
  bool SplitCodegen = false;
};

std::optional<EmitOptions> parseEmitOptions(int Argc, char **Argv);
int emit(const EmitOptions &Options);

// How a profile matched the functions of one optimized module: functions
// that received its counts, functions whose control flow changed since it
// was collected, and functions it has no record of. The annotated and the
// mismatched functions are also listed by profile name, with the sum of the
// profile's counters for each, so a changed hot function can weigh more than
// a changed cold one.
struct ModuleProfileMatch {
  uint64_t Annotated = 0;
  uint64_t Mismatched = 0;
  uint64_t Missing = 0;
  std::vector<std::pair<std::string, uint64_t>> AnnotatedCounts;
  std::vector<std::pair<std::string, uint64_t>> MismatchedCounts;
};

// Optimizes `M` with the per-module default pipeline at `OptLevel`, as `emit`
// does for a whole program, with IR instrumentation when `Instrument` is set
// or annotation from the indexed `ProfileUse` profile. Instrumentation writes
// raw profiles to the `ProfileGenerate` pattern; an empty pattern names no
// file, so the program that links the module names it. Returns an error
// message, or nothing on success.
std::optional<std::string> optimizeModule(llvm::Module &M,
                                          llvm::TargetMachine &Machine,
                                          const std::string &OptLevel,
                                          bool Instrument,
                                          const std::string &ProfileGenerate,
                                          const std::string &ProfileUse,
                                          ModuleProfileMatch &Match);

} // namespace scriptc
