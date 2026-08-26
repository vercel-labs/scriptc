#pragma once

#include "llvm/ADT/StringRef.h"
#include "llvm/ADT/Twine.h"

namespace scriptc {

int reportError(llvm::StringRef Code, const llvm::Twine &Message,
                llvm::StringRef DiagnosticFormat = "json");
void installFatalDiagnosticHandler();

} // namespace scriptc
