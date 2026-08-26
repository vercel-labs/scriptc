#include "target.h"

#include "llvm/MC/TargetRegistry.h"
#include "llvm/Support/CodeGen.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/Target/TargetOptions.h"
#include "llvm/TargetParser/Triple.h"

using namespace llvm;

extern "C" {
void LLVMInitializeAArch64TargetInfo();
void LLVMInitializeAArch64Target();
void LLVMInitializeAArch64TargetMC();
void LLVMInitializeAArch64AsmParser();
void LLVMInitializeAArch64AsmPrinter();
}

namespace scriptc {

void initializeTargets() {
  static bool Initialized = false;
  if (Initialized)
    return;
  LLVMInitializeAArch64TargetInfo();
  LLVMInitializeAArch64Target();
  LLVMInitializeAArch64TargetMC();
  LLVMInitializeAArch64AsmParser();
  LLVMInitializeAArch64AsmPrinter();
  Initialized = true;
}

static CodeGenOptLevel codeGenLevel(StringRef Level) {
  if (Level == "0")
    return CodeGenOptLevel::None;
  if (Level == "1")
    return CodeGenOptLevel::Less;
  if (Level == "3")
    return CodeGenOptLevel::Aggressive;
  return CodeGenOptLevel::Default;
}

std::unique_ptr<TargetMachine> createTargetMachine(StringRef TripleName,
                                                   StringRef OptLevel,
                                                   std::string &Error) {
  initializeTargets();
  Triple TargetTriple(TripleName);
  const Target *Definition = TargetRegistry::lookupTarget(TargetTriple, Error);
  if (Definition == nullptr)
    return nullptr;
  TargetOptions Options;
  return std::unique_ptr<TargetMachine>(Definition->createTargetMachine(
      TargetTriple, "generic", "", Options, Reloc::PIC_, CodeModel::Small,
      codeGenLevel(OptLevel)));
}

} // namespace scriptc
