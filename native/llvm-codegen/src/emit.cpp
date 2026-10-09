#include "emit.h"

#include "diagnostics.h"
#include "runtime-import.h"
#include "target.h"

#include "llvm/ADT/SmallString.h"
#include "llvm/ADT/StringRef.h"
#include "llvm/Bitcode/BitcodeReader.h"
#include "llvm/Bitcode/BitcodeWriter.h"
#include "llvm/IR/LegacyPassManager.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/Verifier.h"
#include "llvm/IRReader/IRReader.h"
#include "llvm/Passes/PassBuilder.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/TargetParser/Triple.h"
#include "llvm/Transforms/Utils/SplitModule.h"

#include <optional>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

using namespace llvm;

namespace scriptc {

static constexpr size_t MaxPartitions = 64;

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
      Options.Outputs.push_back(Value.str());
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
    else if (Arg == "--import-bitcode")
      Options.ImportBitcode.push_back(Value.str());
    else
      return std::nullopt;
  }
  if (Options.Input.empty() || Options.Outputs.empty())
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

namespace {

struct EmitFailure {
  std::string Code;
  std::string Message;
};

// Library defaults leave SLP vectorization disabled. Enable both
// vectorizers for speed builds, without permitting floating-point
// reassociation or changing the size/debug optimization policies.
PipelineTuningOptions tuningFor(OptimizationLevel Level) {
  PipelineTuningOptions Tuning;
  if (Level == OptimizationLevel::O2 || Level == OptimizationLevel::O3) {
    Tuning.LoopVectorization = true;
    Tuning.SLPVectorization = true;
  }
  return Tuning;
}

// Owns the analysis managers a pipeline needs for one module.
struct Pipeline {
  LoopAnalysisManager LAM;
  FunctionAnalysisManager FAM;
  CGSCCAnalysisManager CGAM;
  ModuleAnalysisManager MAM;
  PassBuilder PB;

  Pipeline(TargetMachine &Machine, OptimizationLevel Level)
      : PB(&Machine, tuningFor(Level)) {
    PB.registerModuleAnalyses(MAM);
    PB.registerCGSCCAnalyses(CGAM);
    PB.registerFunctionAnalyses(FAM);
    PB.registerLoopAnalyses(LAM);
    PB.crossRegisterProxies(LAM, FAM, CGAM, MAM);
  }
};

std::optional<EmitFailure> verify(Module &M, StringRef Code) {
  std::string Error;
  raw_string_ostream Stream(Error);
  if (verifyModule(M, &Stream))
    return EmitFailure{Code.str(), Stream.str()};
  return std::nullopt;
}

// Writes code for an optimized module to a unique sibling of OutputPath,
// which is appended to Temporaries once it exists.
std::optional<EmitFailure>
generateCode(Module &M, TargetMachine &Machine, CodeGenFileType Type,
             StringRef OutputPath, std::vector<SmallString<256>> &Temporaries) {
  SmallString<256> TemporaryPath(OutputPath);
  TemporaryPath.append(".tmp-%%%%%%");
  int TemporaryFd = -1;
  if (std::error_code EC =
          sys::fs::createUniqueFile(TemporaryPath, TemporaryFd, TemporaryPath))
    return EmitFailure{"output_open_failed", EC.message()};
  Temporaries.push_back(TemporaryPath);
  raw_fd_ostream Output(TemporaryFd, true);
  legacy::PassManager CodeGeneration;
  if (Machine.addPassesToEmitFile(CodeGeneration, Output, nullptr, Type))
    return EmitFailure{"emission_not_supported",
                       "target does not support the requested file type"};
  CodeGeneration.run(M);
  Output.flush();
  if (Output.has_error())
    return EmitFailure{"output_write_failed", Output.error().message()};
  return std::nullopt;
}

std::optional<EmitFailure> publish(StringRef TemporaryPath,
                                   StringRef OutputPath) {
  uint64_t Size = 0;
  if (std::error_code EC = sys::fs::file_size(TemporaryPath, Size))
    return EmitFailure{"output_verify_failed", EC.message()};
  if (Size == 0)
    return EmitFailure{"output_verify_failed", "LLVM emitted an empty file"};
  if (std::error_code EC = sys::fs::rename(TemporaryPath, OutputPath))
    return EmitFailure{"output_publish_failed", EC.message()};
  return std::nullopt;
}

std::optional<EmitFailure>
emitModule(Module &M, TargetMachine &Machine, OptimizationLevel Level,
           CodeGenFileType Type, StringRef OutputPath,
           std::vector<SmallString<256>> &Temporaries) {
  Pipeline P(Machine, Level);
  P.PB.buildPerModuleDefaultPipeline(Level).run(M, P.MAM);
  if (std::optional<EmitFailure> Failure =
          verify(M, "post_optimization_verification_failed"))
    return Failure;
  return generateCode(M, Machine, Type, OutputPath, Temporaries);
}

// Large programs keep whole-program simplification, including every inlining
// decision, then split into independent partitions whose remaining
// optimization and code generation run concurrently. Each partition is
// reloaded from bitcode in its own context because LLVM contexts are not
// shared across threads. The split is a deterministic function of the module
// and partition count, so output never depends on host parallelism.
std::optional<EmitFailure>
emitPartitions(std::unique_ptr<Module> Mod, const EmitOptions &Options,
               OptimizationLevel Level, CodeGenFileType Type,
               std::vector<SmallString<256>> &Temporaries) {
  {
    std::string LookupError;
    std::unique_ptr<TargetMachine> Machine =
        createTargetMachine(Options.Target, Options.OptLevel, LookupError);
    if (!Machine)
      return EmitFailure{"target_machine_failed", LookupError};
    Pipeline P(*Machine, Level);
    P.PB.buildModuleSimplificationPipeline(Level, ThinOrFullLTOPhase::None)
        .run(*Mod, P.MAM);
  }
  size_t Count = Options.Outputs.size();
  std::vector<SmallVector<char, 0>> Partitions;
  SplitModule(*Mod, static_cast<unsigned>(Count),
              [&](std::unique_ptr<Module> Partition) {
                Partitions.emplace_back();
                raw_svector_ostream Stream(Partitions.back());
                WriteBitcodeToFile(*Partition, Stream);
              });
  Mod.reset();
  if (Partitions.size() != Count)
    return EmitFailure{"partition_failed", "LLVM produced an unexpected number "
                                           "of program partitions"};

  std::vector<std::optional<EmitFailure>> Failures(Count);
  std::vector<std::vector<SmallString<256>>> Written(Count);
  std::vector<std::thread> Workers;
  for (size_t I = 0; I < Count; ++I) {
    Workers.emplace_back([&, I] {
      LLVMContext Context;
      Expected<std::unique_ptr<Module>> Partition = parseBitcodeFile(
          MemoryBufferRef(StringRef(Partitions[I].data(), Partitions[I].size()),
                          Options.Outputs[I]),
          Context);
      if (!Partition) {
        Failures[I] =
            EmitFailure{"partition_failed", toString(Partition.takeError())};
        return;
      }
      std::string LookupError;
      std::unique_ptr<TargetMachine> Machine =
          createTargetMachine(Options.Target, Options.OptLevel, LookupError);
      if (!Machine) {
        Failures[I] = EmitFailure{"target_machine_failed", LookupError};
        return;
      }
      Pipeline P(*Machine, Level);
      P.PB.buildModuleOptimizationPipeline(Level, ThinOrFullLTOPhase::None)
          .run(**Partition, P.MAM);
      Failures[I] =
          verify(**Partition, "post_optimization_verification_failed");
      if (!Failures[I])
        Failures[I] = generateCode(**Partition, *Machine, Type,
                                   Options.Outputs[I], Written[I]);
    });
  }
  for (std::thread &Worker : Workers)
    Worker.join();
  for (size_t I = 0; I < Count; ++I) {
    if (Written[I].empty())
      Temporaries.emplace_back();
    else
      Temporaries.push_back(Written[I].front());
  }
  for (std::optional<EmitFailure> &Failure : Failures)
    if (Failure)
      return Failure;
  return std::nullopt;
}

} // namespace

int emit(const EmitOptions &Options) {
  if (!supportsTarget(Options.Target))
    return reportError("unsupported_target",
                       Twine("unsupported target '") + Options.Target +
                           "' (supported: " + AllowedTargets + ")",
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
  if (Options.Outputs.size() > MaxPartitions)
    return reportError("invalid_partitions",
                       Twine("at most ") + Twine(MaxPartitions) +
                           " outputs are supported",
                       Options.DiagnosticFormat);
  if (Options.Outputs.size() > 1 &&
      (Options.FileType != "obj" || Options.OptLevel == "0"))
    return reportError("invalid_partitions",
                       "several outputs require optimized object emission",
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
  std::string VerificationError;
  raw_string_ostream VerificationStream(VerificationError);
  if (verifyModule(*Mod, &VerificationStream))
    return reportError("verification_failed", VerificationStream.str(),
                       Options.DiagnosticFormat);

  // Runtime bitcode import is the `speed` posture's opt-in; without it the
  // module reaches the pipeline exactly as emitted.
  if (!Options.ImportBitcode.empty()) {
    if (Options.OptLevel == "0")
      return reportError("invalid_import",
                         "runtime bitcode import requires an optimized build",
                         Options.DiagnosticFormat);
    // The emitter marks every function sanitize_address so the sanitized
    // lane's clang link can instrument it. This helper never runs a
    // sanitizer pass, so the attribute is inert here except that it
    // suppresses speculative loads and blocks inlining of runtime bodies,
    // whose sanitizer attributes must match. Dropping it does not change
    // program semantics.
    for (Function &F : *Mod)
      F.removeFnAttr(Attribute::SanitizeAddress);
    if (std::optional<std::string> Error =
            importRuntimeBitcode(*Mod, Options.ImportBitcode))
      return reportError("runtime_import_failed", *Error,
                         Options.DiagnosticFormat);
    std::string ImportError;
    raw_string_ostream ImportStream(ImportError);
    if (verifyModule(*Mod, &ImportStream))
      return reportError("runtime_import_verification_failed",
                         ImportStream.str(), Options.DiagnosticFormat);
  }

  OptimizationLevel Level = optimizationLevel(Options.OptLevel);
  CodeGenFileType Type = Options.FileType == "obj"
                             ? CodeGenFileType::ObjectFile
                             : CodeGenFileType::AssemblyFile;
  std::vector<SmallString<256>> Temporaries;
  std::optional<EmitFailure> Failure =
      Options.Outputs.size() == 1
          ? emitModule(*Mod, *Machine, Level, Type, Options.Outputs[0],
                       Temporaries)
          : emitPartitions(std::move(Mod), Options, Level, Type, Temporaries);
  for (size_t I = 0; !Failure && I < Temporaries.size(); ++I)
    Failure = publish(Temporaries[I], Options.Outputs[I]);
  if (Failure) {
    for (const SmallString<256> &Temporary : Temporaries)
      sys::fs::remove(Temporary);
    return reportError(Failure->Code, Failure->Message,
                       Options.DiagnosticFormat);
  }
  return 0;
}

} // namespace scriptc
