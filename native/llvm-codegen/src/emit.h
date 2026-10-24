#pragma once

#include <optional>
#include <string>
#include <vector>

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
  // at run time). Empty: no instrumentation.
  std::string ProfileGenerate;
  // Indexed profile (.profdata) that guides optimization. Empty: none.
  std::string ProfileUse;
  // The inliner's threshold for the optimization pipelines. 0: the default
  // for the optimization level.
  unsigned InlineThreshold = 0;
};

std::optional<EmitOptions> parseEmitOptions(int Argc, char **Argv);
int emit(const EmitOptions &Options);

} // namespace scriptc
