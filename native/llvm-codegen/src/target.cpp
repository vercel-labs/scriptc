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
void LLVMInitializeAArch64AsmParser();
}
#endif
#if defined(SCRIPTC_ENABLE_X86)
extern "C" {
void LLVMInitializeX86TargetInfo();
void LLVMInitializeX86Target();
void LLVMInitializeX86TargetMC();
void LLVMInitializeX86AsmPrinter();
void LLVMInitializeX86AsmParser();
}
#endif
#if defined(SCRIPTC_ENABLE_WEBASSEMBLY)
extern "C" {
void LLVMInitializeWebAssemblyTargetInfo();
void LLVMInitializeWebAssemblyTarget();
void LLVMInitializeWebAssemblyTargetMC();
void LLVMInitializeWebAssemblyAsmPrinter();
void LLVMInitializeWebAssemblyAsmParser();
}
#endif

namespace scriptc {

static bool registerTargets() {
#if defined(SCRIPTC_ENABLE_AARCH64)
  LLVMInitializeAArch64TargetInfo();
  LLVMInitializeAArch64Target();
  LLVMInitializeAArch64TargetMC();
  LLVMInitializeAArch64AsmPrinter();
  // Runtime units may contain inline assembly (runtime-unit emission).
  LLVMInitializeAArch64AsmParser();
#endif
#if defined(SCRIPTC_ENABLE_X86)
  LLVMInitializeX86TargetInfo();
  LLVMInitializeX86Target();
  LLVMInitializeX86TargetMC();
  LLVMInitializeX86AsmPrinter();
  // Runtime units may contain inline assembly (runtime-unit emission).
  LLVMInitializeX86AsmParser();
#endif
#if defined(SCRIPTC_ENABLE_WEBASSEMBLY)
  LLVMInitializeWebAssemblyTargetInfo();
  LLVMInitializeWebAssemblyTarget();
  LLVMInitializeWebAssemblyTargetMC();
  LLVMInitializeWebAssemblyAsmPrinter();
  // Runtime units may contain inline assembly (runtime-unit emission).
  LLVMInitializeWebAssemblyAsmParser();
#endif
  return true;
}

// Partitions create target machines on several threads; the registry must be
// populated exactly once before any lookup.
void initializeTargets() {
  static const bool Registered = registerTargets();
  (void)Registered;
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

CodeGenOptLevel codeGenLevel(StringRef Level) {
  if (Level == "0")
    return CodeGenOptLevel::None;
  if (Level == "1")
    return CodeGenOptLevel::Less;
  if (Level == "3")
    return CodeGenOptLevel::Aggressive;
  return CodeGenOptLevel::Default;
}

static bool ProfileLayout = false;

void enableProfileLayout() { ProfileLayout = true; }

TargetOptions targetOptions(const Triple &TargetTriple) {
  TargetOptions Options;
  // The Android API 26 runtime pack uses the NDK's emulated TLS ABI.
  // Program globals and runtime thread instances must use the same ABI.
  Options.EmulatedTLS = TargetTriple.isAndroid();
  // Program constructors go in .init_array, which the C runtime's startup
  // files run on ELF, as runtime units' constructors do (runtime-unit.cpp).
  Options.UseInitArray = TargetTriple.isOSBinFormatELF();
  if (ProfileLayout && TargetTriple.isOSBinFormatELF()) {
    Options.FunctionSections = true;
    Options.EnableMachineFunctionSplitter = true;
  }
  return Options;
}

std::unique_ptr<TargetMachine> createTargetMachine(StringRef TripleName,
                                                   StringRef OptLevel,
                                                   std::string &Error,
                                                   bool RequireAllowed) {
  initializeTargets();
  if (RequireAllowed && !supportsTarget(TripleName)) {
    Error = (Twine("target '") + TripleName + "' was not compiled into this helper").str();
    return nullptr;
  }
  Triple TargetTriple(TripleName);
  const Target *Definition = TargetRegistry::lookupTarget(TargetTriple, Error);
  if (Definition == nullptr)
    return nullptr;
  return std::unique_ptr<TargetMachine>(Definition->createTargetMachine(
      TargetTriple, "generic", "", targetOptions(TargetTriple), Reloc::PIC_,
      CodeModel::Small, codeGenLevel(OptLevel)));
}

} // namespace scriptc
