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
#include "emit.h"
#include "runtime-import.h"
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
#include "llvm/ProfileData/InstrProf.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/FormatVariadic.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/TargetParser/Triple.h"
#include "llvm/Transforms/Utils/Cloning.h"
#include "llvm/Transforms/Utils/SizeOpts.h"

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
  // When set, the input is unoptimized and the helper optimizes it at this
  // level, with the profile-guided optimization below; otherwise the input
  // is already optimized and is only promoted and emitted.
  std::string OptLevel;
  // Instruments the unit for IR profiling; raw profiles go to this pattern,
  // or, when it is empty, to the file the program that links the unit names.
  bool ProfileGenerate = false;
  std::string ProfileGeneratePattern;
  // Indexed profile (.profdata) that guides the unit's optimization.
  std::string ProfileUse;
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
    else if (Arg == "--opt-level")
      Options.OptLevel = Value.str();
    else if (Arg == "--profile-generate") {
      Options.ProfileGenerate = true;
      Options.ProfileGeneratePattern = Value.str();
    } else if (Arg == "--profile-use")
      Options.ProfileUse = Value.str();
    else
      return std::nullopt;
  }
  if (Options.Input.empty() || Options.Object.empty() ||
      Options.Bitcode.empty() || Options.Target.empty() || Options.Tag.empty())
    return std::nullopt;
  // A profile only guides an optimization the helper runs, and a unit is
  // either instrumented or annotated.
  if ((Options.ProfileGenerate || !Options.ProfileUse.empty()) &&
      Options.OptLevel.empty())
    return std::nullopt;
  if (Options.ProfileGenerate && !Options.ProfileUse.empty())
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

// The profile's counters and per-function records (instrumented units only)
// stay private to the unit: the profile runtime finds them by section.
bool profileData(const GlobalValue &GV) {
  if (const auto *Object = dyn_cast<GlobalObject>(&GV))
    if (Object->getSection().starts_with("__llvm_prf"))
      return true;
  return GV.getName().starts_with("__llvm_prf") ||
         GV.getName().starts_with("__profc_") ||
         GV.getName().starts_with("__profd_") ||
         GV.getName().starts_with("__profvp_");
}

void promoteLocals(Module &M, StringRef Tag) {
  unsigned Anonymous = 0;
  auto Promote = [&](GlobalValue &GV) {
    if (!GV.hasLocalLinkage() || keepLocal(GV) || profileData(GV))
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
                "--function-sections --data-sections, and --opt-level <level> "
                "with either --profile-generate <pattern> or --profile-use "
                "<profdata>");
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

  // Profiles name a unit's internal functions after its source file. The
  // unit's own name keeps those names the same in every checkout, so a
  // committed profile matches wherever the pack is built.
  if (!Options->OptLevel.empty()) {
    M->setSourceFileName(Options->Tag + ".c");
    // The runtime profile comes from a fixed set of training programs, and a
    // runtime function they rarely call can be hot in another program (a
    // long UTF-8 decode, a busy worker channel). Code the profile finds cold
    // is therefore optimized for speed as without a profile, not for size:
    // the profile still guides inlining, block layout and branch weights.
    EnablePGSO.setValue(false);
    // The profile names of the functions an instrumented unit defines, so
    // a merged profile can keep the runtime's records and drop the
    // training programs'.
    json::Array Functions;
    if (Options->ProfileGenerate)
      for (const Function &F : *M)
        if (!F.isDeclaration() && !F.hasAvailableExternallyLinkage())
          Functions.push_back(getIRPGOFuncName(F));
    ModuleProfileMatch Match;
    if (std::optional<std::string> Failure = optimizeModule(
            *M, *Machine, Options->OptLevel, Options->ProfileGenerate,
            Options->ProfileGeneratePattern, Options->ProfileUse, Match))
      return fail("optimization_failed", *Failure);
    if (!Options->ProfileUse.empty()) {
      // Each matched function's counters in the profile, by profile name.
      auto Counts =
          [](const std::vector<std::pair<std::string, uint64_t>> &List) {
            json::Object Object;
            for (const auto &[Name, Sum] : List)
              Object[Name] = Sum;
            return Object;
          };
      json::Object Profile{
          {"annotated", Match.Annotated},
          {"mismatched", Match.Mismatched},
          {"missing", Match.Missing},
          {"annotated_counts", Counts(Match.AnnotatedCounts)},
          {"mismatched_counts", Counts(Match.MismatchedCounts)}};
      json::Object Response{{"ok", true}, {"profile", std::move(Profile)}};
      outs() << formatv("{0}\n", json::Value(std::move(Response)));
    } else if (Options->ProfileGenerate) {
      json::Object Response{{"ok", true}, {"functions", std::move(Functions)}};
      outs() << formatv("{0}\n", json::Value(std::move(Response)));
    }
  }

  promoteLocals(*M, Options->Tag);
  std::string VerifyError;
  raw_string_ostream VerifyStream(VerifyError);
  if (verifyModule(*M, &VerifyStream))
    return fail("verification_failed", VerifyStream.str());

  // The bitcode exists only to be imported from, so it carries only what
  // an import can take; program builds then read a fraction of the unit.
  std::unique_ptr<Module> Import = CloneModule(*M);
  pruneRuntimeImport(*Import);
  if (verifyModule(*Import, &VerifyStream))
    return fail("verification_failed", VerifyStream.str());
  if (std::optional<std::string> Failure = writeFileAtomically(
          Options->Bitcode,
          [&](raw_fd_ostream &Out) { WriteBitcodeToFile(*Import, Out); }))
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

int pruneImport(int Argc, char **Argv) {
  std::string Input, Output;
  bool Valid = Argc % 2 == 0;
  for (int I = 2; Valid && I + 1 < Argc; I += 2) {
    StringRef Arg(Argv[I]);
    if (Arg == "--input")
      Input = Argv[I + 1];
    else if (Arg == "--output")
      Output = Argv[I + 1];
    else
      Valid = false;
  }
  if (!Valid || Input.empty() || Output.empty())
    return fail("usage", "prune-import requires --input <bc> --output <bc>");
  LLVMContext Context;
  SMDiagnostic Diagnostic;
  std::unique_ptr<Module> M = parseIRFile(Input, Diagnostic, Context);
  if (!M) {
    std::string Detail;
    raw_string_ostream Stream(Detail);
    Diagnostic.print("scriptc-llvm-codegen", Stream);
    return fail("invalid_ir", Stream.str());
  }
  pruneRuntimeImport(*M);
  std::string VerifyError;
  raw_string_ostream VerifyStream(VerifyError);
  if (verifyModule(*M, &VerifyStream))
    return fail("verification_failed", VerifyStream.str());
  if (std::optional<std::string> Failure = writeFileAtomically(
          Output, [&](raw_fd_ostream &Out) { WriteBitcodeToFile(*M, Out); }))
    return fail("output_write_failed", *Failure);
  return 0;
}

} // namespace scriptc
