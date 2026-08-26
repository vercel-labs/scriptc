#include "diagnostics.h"

#include "llvm/Support/ErrorHandling.h"
#include "llvm/Support/FormatVariadic.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/raw_ostream.h"

#include <cstdlib>

using namespace llvm;

namespace scriptc {

int reportError(StringRef Code, const Twine &Message,
                StringRef DiagnosticFormat) {
  if (DiagnosticFormat == "json") {
    json::Object Diagnostic{
        {"ok", false},
        {"code", Code},
        {"message", Message.str()},
    };
    errs() << formatv("{0}\n", json::Value(std::move(Diagnostic)));
  } else {
    errs() << "scriptc-llvm-codegen: " << Message << '\n';
  }
  return 1;
}

static void fatalDiagnostic(void *, const char *Reason, bool) {
  json::Object Diagnostic{
      {"ok", false},
      {"code", "llvm_fatal"},
      {"message", Reason == nullptr ? "LLVM reported a fatal error" : Reason},
  };
  errs() << formatv("{0}\n", json::Value(std::move(Diagnostic)));
  errs().flush();
  std::_Exit(70);
}

void installFatalDiagnosticHandler() {
  install_fatal_error_handler(fatalDiagnostic, nullptr);
}

} // namespace scriptc
