#include "diagnostics.h"
#include "emit.h"
#include "target.h"

#include "llvm/ADT/StringRef.h"
#include "llvm/Support/FormatVariadic.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/ErrorHandling.h"
#include "llvm/Support/TargetSelect.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/TargetParser/Host.h"

#include <optional>
#include <cstdlib>
#include <string>

using namespace llvm;

#ifndef SCRIPTC_PACKAGE_VERSION
#define SCRIPTC_PACKAGE_VERSION "0.0.0-dev"
#endif

namespace {

int version(int Argc, char **Argv) {
  if (Argc != 3 || StringRef(Argv[2]) != "--format=json")
    return scriptc::reportError("usage", "version requires --format=json");
  std::string Error;
  std::unique_ptr<TargetMachine> Machine = scriptc::createTargetMachine(
      scriptc::DefaultTarget, "2", Error);
  if (!Machine)
    return scriptc::reportError("target_machine_failed", Error);

  json::Object Response{
      {"ok", true},
      {"protocol_version", scriptc::ProtocolVersion},
      {"scriptc_package_version", SCRIPTC_PACKAGE_VERSION},
      {"llvm_version", LLVM_VERSION_STRING},
      {"host_triple", sys::getDefaultTargetTriple()},
      {"targets", json::Array{"AArch64"}},
      {"default_target", scriptc::DefaultTarget},
      {"data_layout", Machine->createDataLayout().getStringRepresentation()},
  };
  outs() << formatv("{0}\n", json::Value(std::move(Response)));
  return 0;
}

} // namespace

int main(int Argc, char **Argv) {
  scriptc::installFatalDiagnosticHandler();
  // Process-isolated test seam for the fatal handler itself. It is inert in
  // every ordinary invocation and ensures a future LLVM fatal never becomes
  // an unstructured abort/stack trace in the Node caller.
  if (std::getenv("SCRIPTC_LLVM_TEST_FATAL") != nullptr)
    report_fatal_error("scriptc LLVM fatal diagnostic self-test");
  if (Argc >= 2 && StringRef(Argv[1]) == "version")
    return version(Argc, Argv);
  if (Argc >= 2 && StringRef(Argv[1]) == "emit") {
    std::optional<scriptc::EmitOptions> Options =
        scriptc::parseEmitOptions(Argc, Argv);
    if (!Options)
      return scriptc::reportError(
          "usage",
          "emit requires --input <file> --output <file> and accepts "
          "--filetype <obj|asm> --target <triple> --opt-level <0|1|2|3|s|z> "
          "--relocation-model pic --diagnostic-format json "
          "--source-path <path>");
    return scriptc::emit(*Options);
  }
  return scriptc::reportError("usage",
                              "expected 'version --format=json' or 'emit'");
}
