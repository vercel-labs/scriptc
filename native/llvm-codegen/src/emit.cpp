#include "emit.h"

#include "diagnostics.h"
#include "target.h"

#include "llvm/ADT/SmallString.h"
#include "llvm/ADT/StringRef.h"
#include "llvm/IR/LegacyPassManager.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/Verifier.h"
#include "llvm/IRReader/IRReader.h"
#include "llvm/Passes/PassBuilder.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/TargetParser/Triple.h"

#include <optional>
#include <string>
#include <system_error>

using namespace llvm;

namespace scriptc {

std::optional<EmitOptions> parseEmitOptions(int Argc, char **Argv) {
  EmitOptions Options;
  Options.Target = DefaultTarget.str();
  for (int I = 2; I < Argc; ++I) {
    StringRef Arg(Argv[I]);
    if (!Arg.starts_with("--") || I + 1 >= Argc)
      return std::nullopt;
    StringRef Value(Argv[++I]);
    if (Arg == "--input")
      Options.Input = Value.str();
    else if (Arg == "--output")
      Options.Output = Value.str();
    else if (Arg == "--filetype")
      Options.FileType = Value.str();
    else if (Arg == "--target")
      Options.Target = Value.str();
    else if (Arg == "--opt-level")
      Options.OptLevel = Value.str();
    else if (Arg == "--relocation-model")
      Options.RelocationModel = Value.str();
    else if (Arg == "--diagnostic-format")
      Options.DiagnosticFormat = Value.str();
    else if (Arg == "--source-path")
      Options.SourcePath = Value.str();
    else
      return std::nullopt;
  }
  if (Options.Input.empty() || Options.Output.empty())
    return std::nullopt;
  return Options;
}

static OptimizationLevel optimizationLevel(StringRef Level) {
  if (Level == "0")
    return OptimizationLevel::O0;
  if (Level == "1")
    return OptimizationLevel::O1;
  if (Level == "3")
    return OptimizationLevel::O3;
  if (Level == "s")
    return OptimizationLevel::Os;
  if (Level == "z")
    return OptimizationLevel::Oz;
  return OptimizationLevel::O2;
}

int emit(const EmitOptions &Options) {
  if (Options.Target != DefaultTarget)
    return reportError("unsupported_target",
                       Twine("unsupported target '") + Options.Target +
                           "' (supported: " + DefaultTarget + ")",
                       Options.DiagnosticFormat);
  if (Options.FileType != "obj" && Options.FileType != "asm")
    return reportError("invalid_filetype", "filetype must be obj or asm",
                       Options.DiagnosticFormat);
  if (Options.OptLevel != "0" && Options.OptLevel != "1" &&
      Options.OptLevel != "2" && Options.OptLevel != "3" &&
      Options.OptLevel != "s" && Options.OptLevel != "z")
    return reportError("invalid_opt_level",
                       "opt-level must be 0, 1, 2, 3, s, or z",
                       Options.DiagnosticFormat);
  if (Options.RelocationModel != "pic")
    return reportError("invalid_relocation_model",
                       "only the pic relocation model is supported",
                       Options.DiagnosticFormat);

  SMDiagnostic ParseDiagnostic;
  LLVMContext Context;
  std::unique_ptr<Module> Mod =
      parseIRFile(Options.Input, ParseDiagnostic, Context);
  if (!Mod) {
    std::string Detail;
    raw_string_ostream Stream(Detail);
    ParseDiagnostic.print("scriptc-llvm-codegen", Stream);
    return reportError("invalid_ir", Stream.str(), Options.DiagnosticFormat);
  }
  if (!Options.SourcePath.empty())
    Mod->setSourceFileName(Options.SourcePath);

  std::string LookupError;
  std::unique_ptr<TargetMachine> Machine =
      createTargetMachine(Options.Target, Options.OptLevel, LookupError);
  if (!Machine)
    return reportError("target_machine_failed", LookupError,
                       Options.DiagnosticFormat);

  Triple TargetTriple(Options.Target);
  Mod->setTargetTriple(TargetTriple);
  Mod->setDataLayout(Machine->createDataLayout());
  if (Mod->getDataLayoutStr() != DefaultDataLayout)
    return reportError("data_layout_mismatch",
                       Twine("LLVM produced unexpected data layout '") +
                           Mod->getDataLayoutStr() + "'",
                       Options.DiagnosticFormat);

  std::string VerificationError;
  raw_string_ostream VerificationStream(VerificationError);
  if (verifyModule(*Mod, &VerificationStream))
    return reportError("verification_failed", VerificationStream.str(),
                       Options.DiagnosticFormat);

  LoopAnalysisManager LAM;
  FunctionAnalysisManager FAM;
  CGSCCAnalysisManager CGAM;
  ModuleAnalysisManager MAM;
  PassBuilder PB(Machine.get());
  PB.registerModuleAnalyses(MAM);
  PB.registerCGSCCAnalyses(CGAM);
  PB.registerFunctionAnalyses(FAM);
  PB.registerLoopAnalyses(LAM);
  PB.crossRegisterProxies(LAM, FAM, CGAM, MAM);
  ModulePassManager Optimizations =
      PB.buildPerModuleDefaultPipeline(optimizationLevel(Options.OptLevel));
  Optimizations.run(*Mod, MAM);

  VerificationError.clear();
  if (verifyModule(*Mod, &VerificationStream))
    return reportError("post_optimization_verification_failed",
                       VerificationStream.str(), Options.DiagnosticFormat);

  SmallString<256> OutputPath(Options.Output);
  SmallString<256> TemporaryPath(OutputPath);
  TemporaryPath.append(".tmp-%%%%%%");
  int TemporaryFd = -1;
  if (std::error_code EC =
          sys::fs::createUniqueFile(TemporaryPath, TemporaryFd, TemporaryPath))
    return reportError("output_open_failed", EC.message(),
                       Options.DiagnosticFormat);

  {
    raw_fd_ostream Output(TemporaryFd, true);
    legacy::PassManager CodeGeneration;
    CodeGenFileType Type = Options.FileType == "obj"
                               ? CodeGenFileType::ObjectFile
                               : CodeGenFileType::AssemblyFile;
    if (Machine->addPassesToEmitFile(CodeGeneration, Output, nullptr, Type)) {
      sys::fs::remove(TemporaryPath);
      return reportError("emission_not_supported",
                         "target does not support the requested file type",
                         Options.DiagnosticFormat);
    }
    CodeGeneration.run(*Mod);
    Output.flush();
    if (Output.has_error()) {
      std::error_code EC = Output.error();
      sys::fs::remove(TemporaryPath);
      return reportError("output_write_failed", EC.message(),
                         Options.DiagnosticFormat);
    }
  }

  uint64_t Size = 0;
  if (std::error_code EC = sys::fs::file_size(TemporaryPath, Size)) {
    sys::fs::remove(TemporaryPath);
    return reportError("output_verify_failed", EC.message(),
                       Options.DiagnosticFormat);
  }
  if (Size == 0) {
    sys::fs::remove(TemporaryPath);
    return reportError("output_verify_failed", "LLVM emitted an empty file",
                       Options.DiagnosticFormat);
  }
  if (std::error_code EC = sys::fs::rename(TemporaryPath, OutputPath)) {
    sys::fs::remove(TemporaryPath);
    return reportError("output_publish_failed", EC.message(),
                       Options.DiagnosticFormat);
  }
  return 0;
}

} // namespace scriptc
