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
inline constexpr llvm::StringLiteral DefaultTarget =
    "arm64-apple-macosx14.0.0";
inline constexpr llvm::StringLiteral DefaultDataLayout =
    "e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-n32:64-S128-Fn32";

void initializeTargets();
std::unique_ptr<llvm::TargetMachine>
createTargetMachine(llvm::StringRef Triple, llvm::StringRef OptLevel,
                    std::string &Error);

} // namespace scriptc
