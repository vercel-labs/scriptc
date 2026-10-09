// `runtime-unit`: turn one optimized runtime translation unit into the pair
// of artifacts a runtime pack ships for it: the native object and the
// bitcode the program build imports from (see runtime-import.cpp).
//
// Both come from one module. Every translation-unit-local symbol that an
// imported body could need (functions, mutable state, address-significant
// constants) is first promoted to a hidden external symbol with a stable,
// unit-qualified name, exactly like ThinLTO's local promotion. An imported
// copy of a small runtime function can then name the unit's private state
// and helpers, and the reference resolves to the single definition in the
// object. Promotion changes symbol binding only; the code is otherwise what
// the runtime compiler optimized.
#include "runtime-unit.h"

#include "diagnostics.h"
#include "target.h"

#include "llvm/ADT/SmallString.h"
#include "llvm/ADT/StringRef.h"
#include "llvm/Bitcode/BitcodeReader.h"
#include "llvm/Bitcode/BitcodeWriter.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/GlobalVariable.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/LegacyPassManager.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/Verifier.h"
#include "llvm/IRReader/IRReader.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/TargetParser/Triple.h"

#include <memory>
#include <optional>
#include <string>
#include <vector>

using namespace llvm;

namespace scriptc {

namespace {

struct UnitOptions {
  std::string Input;
  std::string Object;
  std::string Bitcode;
  std::string Target;
  std::string Tag;
  bool FunctionSections = false;
  bool DataSections = false;
};

std::optional<UnitOptions> parse(int Argc, char **Argv) {
  UnitOptions Options;
  for (int I = 2; I < Argc; ++I) {
    StringRef Arg(Argv[I]);
    if (Arg == "--function-sections") {
      Options.FunctionSections = true;
      continue;
    }
    if (Arg == "--data-sections") {
      Options.DataSections = true;
      continue;
    }
    if (!Arg.starts_with("--") || I + 1 >= Argc)
      return std::nullopt;
    StringRef Value(Argv[++I]);
    if (Arg == "--input")
      Options.Input = Value.str();
    else if (Arg == "--object")
      Options.Object = Value.str();
    else if (Arg == "--bitcode")
      Options.Bitcode = Value.str();
    else if (Arg == "--target")
      Options.Target = Value.str();
    else if (Arg == "--tag")
      Options.Tag = Value.str();
    else
      return std::nullopt;
  }
  if (Options.Input.empty() || Options.Object.empty() ||
      Options.Bitcode.empty() || Options.Target.empty() || Options.Tag.empty())
    return std::nullopt;
  return Options;
}

// Constants whose address is insignificant are copied by the importer
// instead (string literals stay mergeable in their literal sections).
bool keepLocal(const GlobalValue &GV) {
  if (const auto *Var = dyn_cast<GlobalVariable>(&GV))
    return Var->isConstant() && !Var->isThreadLocal() &&
           Var->hasAtLeastLocalUnnamedAddr();
  return false;
}

void promoteLocals(Module &M, StringRef Tag) {
  unsigned Anonymous = 0;
  auto Promote = [&](GlobalValue &GV) {
    if (!GV.hasLocalLinkage() || keepLocal(GV))
      return;
    std::string Base =
        GV.hasName() ? GV.getName().str() : ("anon." + Twine(Anonymous++)).str();
    GV.setName(Base + ".scrunit." + Tag.str());
    GV.setLinkage(GlobalValue::ExternalLinkage);
    GV.setVisibility(GlobalValue::HiddenVisibility);
    GV.setDSOLocal(true);
  };
  for (Function &F : M)
    if (!F.isDeclaration())
      Promote(F);
  for (GlobalVariable &V : M.globals())
    if (!V.isDeclaration() && !V.hasAppendingLinkage())
      Promote(V);
  for (GlobalAlias &A : M.aliases())
    Promote(A);
}

int fail(StringRef Code, const Twine &Message) {
  return reportError(Code, Message, "json");
}

std::optional<std::string> writeFileAtomically(
    StringRef Path, function_ref<void(raw_fd_ostream &)> Write) {
  SmallString<256> Temporary(Path);
  Temporary.append(".tmp-%%%%%%");
  int Fd = -1;
  if (std::error_code EC = sys::fs::createUniqueFile(Temporary, Fd, Temporary))
    return EC.message();
  {
    raw_fd_ostream Out(Fd, true);
    Write(Out);
    Out.flush();
    if (Out.has_error()) {
      std::string Message = Out.error().message();
      Out.clear_error();
      sys::fs::remove(Temporary);
      return Message;
    }
  }
  if (std::error_code EC = sys::fs::rename(Temporary, Path)) {
    sys::fs::remove(Temporary);
    return EC.message();
  }
  return std::nullopt;
}

} // namespace

int runtimeUnit(int Argc, char **Argv) {
  std::optional<UnitOptions> Options = parse(Argc, Argv);
  if (!Options)
    return fail("usage",
                "runtime-unit requires --input <bc> --object <o> --bitcode <bc> "
                "--target <triple> --tag <unit> and accepts "
                "--function-sections --data-sections");
  LLVMContext Context;
  SMDiagnostic Diagnostic;
  std::unique_ptr<Module> M = parseIRFile(Options->Input, Diagnostic, Context);
  if (!M) {
    std::string Detail;
    raw_string_ostream Stream(Detail);
    Diagnostic.print("scriptc-llvm-codegen", Stream);
    return fail("invalid_ir", Stream.str());
  }
  // Runtime compilers may spell OS and libc versions into the triple (zig:
  // x86_64-unknown-linux5.10.0-gnu2.34.0) or use another environment ABI
  // for the same platform (zig builds the Windows pack as windows-gnu). The
  // object must follow the unit's own ABI, so code generation uses the
  // unit's triple once architecture and OS match the pack target.
  const Triple &UnitTriple = M->getTargetTriple();
  Triple Expected(Options->Target);
  if (UnitTriple.getArch() != Expected.getArch() ||
      UnitTriple.getOS() != Expected.getOS())
    return fail("target_mismatch", Twine("runtime unit targets '") +
                                       M->getTargetTriple().str() + "', not '" +
                                       Options->Target + "'");
  std::string Error;
  if (!supportsTarget(Options->Target))
    return fail("unsupported_target", Twine("unsupported target '") +
                                          Options->Target + "'");
  std::unique_ptr<TargetMachine> Machine = createTargetMachine(
      UnitTriple.str(), "2", Error, /*RequireAllowed=*/false);
  if (!Machine)
    return fail("target_machine_failed", Error);
  if (M->getDataLayout() != Machine->createDataLayout())
    return fail("data_layout_mismatch",
                "runtime unit data layout differs from the helper target");
  // Objects are position independent like every program object, and use
  // the section layout the pack matrix requests for dead stripping.
  Triple TargetTriple = UnitTriple;
  // Clang always places WebAssembly functions and data in their own
  // sections; the wasm object writer requires it.
  Machine->Options.FunctionSections =
      Options->FunctionSections || TargetTriple.isOSBinFormatWasm();
  Machine->Options.DataSections =
      Options->DataSections || TargetTriple.isOSBinFormatWasm();
  Machine->Options.UseInitArray = TargetTriple.isOSBinFormatELF();

  // Apple clang protects every frame against stack clashes by calling
  // __chkstk_darwin, a probing method upstream LLVM does not lower. Keep the
  // protection with LLVM's equivalent inline probes.
  for (Function &F : *M)
    if (F.getFnAttribute("probe-stack").getValueAsString() == "__chkstk_darwin")
      F.addFnAttr("probe-stack", "inline-asm");

  promoteLocals(*M, Options->Tag);
  std::string VerifyError;
  raw_string_ostream VerifyStream(VerifyError);
  if (verifyModule(*M, &VerifyStream))
    return fail("verification_failed", VerifyStream.str());

  if (std::optional<std::string> Failure = writeFileAtomically(
          Options->Bitcode,
          [&](raw_fd_ostream &Out) { WriteBitcodeToFile(*M, Out); }))
    return fail("output_write_failed", *Failure);

  bool Unsupported = false;
  std::optional<std::string> Failure =
      writeFileAtomically(Options->Object, [&](raw_fd_ostream &Out) {
        legacy::PassManager CodeGeneration;
        if (Machine->addPassesToEmitFile(CodeGeneration, Out, nullptr,
                                         CodeGenFileType::ObjectFile)) {
          Unsupported = true;
          return;
        }
        CodeGeneration.run(*M);
      });
  if (Unsupported) {
    sys::fs::remove(Options->Object);
    return fail("emission_not_supported",
                "target does not support object emission");
  }
  if (Failure)
    return fail("output_write_failed", *Failure);
  return 0;
}

} // namespace scriptc
