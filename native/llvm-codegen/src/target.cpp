#include "target.h"

#include "llvm/MC/TargetRegistry.h"
#include "llvm/Support/CodeGen.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/Target/TargetOptions.h"
#include "llvm/TargetParser/Triple.h"

using namespace llvm;

#if defined(SCRIPTC_ENABLE_AARCH64)
extern "C" {
void LLVMInitializeAArch64TargetInfo();
void LLVMInitializeAArch64Target();
void LLVMInitializeAArch64TargetMC();
void LLVMInitializeAArch64AsmPrinter();
}
#endif
#if defined(SCRIPTC_ENABLE_X86)
extern "C" {
void LLVMInitializeX86TargetInfo();
void LLVMInitializeX86Target();
void LLVMInitializeX86TargetMC();
void LLVMInitializeX86AsmPrinter();
}
#endif
#if defined(SCRIPTC_ENABLE_WEBASSEMBLY)
extern "C" {
void LLVMInitializeWebAssemblyTargetInfo();
void LLVMInitializeWebAssemblyTarget();
void LLVMInitializeWebAssemblyTargetMC();
void LLVMInitializeWebAssemblyAsmPrinter();
}
#endif

namespace scriptc {

void initializeTargets() {
  static bool Initialized = false;
  if (Initialized)
    return;
#if defined(SCRIPTC_ENABLE_AARCH64)
  LLVMInitializeAArch64TargetInfo();
  LLVMInitializeAArch64Target();
  LLVMInitializeAArch64TargetMC();
  LLVMInitializeAArch64AsmPrinter();
#endif
#if defined(SCRIPTC_ENABLE_X86)
  LLVMInitializeX86TargetInfo();
  LLVMInitializeX86Target();
  LLVMInitializeX86TargetMC();
  LLVMInitializeX86AsmPrinter();
#endif
#if defined(SCRIPTC_ENABLE_WEBASSEMBLY)
  LLVMInitializeWebAssemblyTargetInfo();
  LLVMInitializeWebAssemblyTarget();
  LLVMInitializeWebAssemblyTargetMC();
  LLVMInitializeWebAssemblyAsmPrinter();
#endif
  Initialized = true;
}

bool supportsTarget(StringRef TripleName) {
  bool Allowed = false;
  StringRef Remaining = AllowedTargets;
  while (!Remaining.empty()) {
    auto Split = Remaining.split(',');
    if (Split.first == TripleName) {
      Allowed = true;
      break;
    }
    Remaining = Split.second;
  }
  if (!Allowed)
    return false;
  Triple Triple(TripleName);
  switch (Triple.getArch()) {
#if defined(SCRIPTC_ENABLE_AARCH64)
  case Triple::aarch64:
  case Triple::aarch64_be:
    return Triple.isOSBinFormatMachO() || Triple.isOSBinFormatELF();
#endif
#if defined(SCRIPTC_ENABLE_X86)
  case Triple::x86_64:
  case Triple::x86:
    return Triple.isOSBinFormatMachO() || Triple.isOSBinFormatELF() ||
           Triple.isOSBinFormatCOFF();
#endif
#if defined(SCRIPTC_ENABLE_WEBASSEMBLY)
  case Triple::wasm32:
    return Triple.isOSBinFormatWasm();
#endif
  default:
    return false;
  }
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
  if (!supportsTarget(TripleName)) {
    Error = (Twine("target '") + TripleName + "' was not compiled into this helper").str();
    return nullptr;
  }
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
