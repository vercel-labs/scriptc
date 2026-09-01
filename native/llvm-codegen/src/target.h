#pragma once

#include "llvm/ADT/StringRef.h"

#include <memory>
#include <string>

namespace llvm {
class TargetMachine;
}

namespace scriptc {

inline constexpr llvm::StringLiteral ProtocolVersion = "1";
inline constexpr llvm::StringLiteral LlvmVersion = "22.1.8";
#ifndef SCRIPTC_DEFAULT_TARGET
#define SCRIPTC_DEFAULT_TARGET "arm64-apple-macosx14.0.0"
#endif
#ifndef SCRIPTC_DEFAULT_DATA_LAYOUT
#define SCRIPTC_DEFAULT_DATA_LAYOUT "e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-n32:64-S128-Fn32"
#endif
#ifndef SCRIPTC_TARGET_BACKENDS
#define SCRIPTC_TARGET_BACKENDS "AArch64"
#endif
#ifndef SCRIPTC_ALLOWED_TARGETS
#define SCRIPTC_ALLOWED_TARGETS "arm64-apple-macosx14.0.0"
#endif
inline constexpr llvm::StringLiteral DefaultTarget =
    SCRIPTC_DEFAULT_TARGET;
inline constexpr llvm::StringLiteral DefaultDataLayout =
    SCRIPTC_DEFAULT_DATA_LAYOUT;
inline constexpr llvm::StringLiteral TargetBackends = SCRIPTC_TARGET_BACKENDS;
inline constexpr llvm::StringLiteral AllowedTargets = SCRIPTC_ALLOWED_TARGETS;

void initializeTargets();
bool supportsTarget(llvm::StringRef Triple);
std::unique_ptr<llvm::TargetMachine>
createTargetMachine(llvm::StringRef Triple, llvm::StringRef OptLevel,
                    std::string &Error);

} // namespace scriptc
