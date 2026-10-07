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
};

std::optional<EmitOptions> parseEmitOptions(int Argc, char **Argv);
int emit(const EmitOptions &Options);

} // namespace scriptc
