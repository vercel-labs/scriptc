#include "emit.h"

#include "cache.h"
#include "diagnostics.h"
#include "partition.h"
#include "runtime-import.h"
#include "target.h"

#include "llvm/ADT/STLExtras.h"
#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/ADT/SmallString.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/ADT/StringMap.h"
#include "llvm/ADT/StringRef.h"
#include "llvm/ADT/StringSet.h"
#include "llvm/Analysis/RuntimeLibcallInfo.h"
#include "llvm/Analysis/TargetLibraryInfo.h"
#include "llvm/Bitcode/BitcodeReader.h"
#include "llvm/Bitcode/BitcodeWriter.h"
#include "llvm/Bitcode/BitcodeWriterPass.h"
#include "llvm/CodeGen/MachineDominators.h"
#include "llvm/CodeGen/MachineFunction.h"
#include "llvm/CodeGen/MachineFunctionPass.h"
#include "llvm/CodeGen/MachineModuleInfo.h"
#include "llvm/IR/DiagnosticHandler.h"
#include "llvm/IR/DiagnosticInfo.h"
#include "llvm/IR/DiagnosticPrinter.h"
#include "llvm/IR/LegacyPassManager.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/Verifier.h"
#include "llvm/IRReader/IRReader.h"
#include "llvm/LTO/LTO.h"
#include "llvm/Pass.h"
#include "llvm/PassInfo.h"
#include "llvm/PassRegistry.h"
#include "llvm/Passes/PassBuilder.h"
#include "llvm/ProfileData/InstrProfReader.h"
#include "llvm/Support/CommandLine.h"
#include "llvm/Support/PGOOptions.h"
#include "llvm/Support/VirtualFileSystem.h"
#include "llvm/Support/Caching.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SHA256.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/ThreadPool.h"
#include "llvm/Support/Threading.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/TargetParser/Triple.h"
#include "llvm/Transforms/Utils/SplitModule.h"

#include <algorithm>
#include <atomic>
#include <mutex>
#include <optional>
#include <string>
#include <system_error>
#include <vector>

using namespace llvm;

namespace scriptc {

static constexpr size_t MaxPartitions = 64;
// The thin link's import allowance for hot and hottest call edges, as a
// multiple of the usual size limit, in builds with a profile. See
// limitProfileImports().
static constexpr const char *ProfileImportMultiplier = "2";
// The thin link's size limit, in instructions, for a callee it imports into
// a partition that calls it. See limitImports().
static constexpr const char *ImportInstructionLimit = "40";

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
    else if (Arg == "--cache-dir")
      Options.CacheDirectory = Value.str();
    else if (Arg == "--profile-generate")
      Options.ProfileGenerate = Value.str();
    else if (Arg == "--profile-use")
      Options.ProfileUse = Value.str();
    else if (Arg == "--split" && Value == "codegen")
      Options.SplitCodegen = true;
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

// Whether the ProfileUse profile also holds context-sensitive counts, which
// a second instrumentation after inlining recorded (inspectProfile).
bool ContextProfile = false;

// The profile-guided optimization a build asks for:
// - IR instrumentation that writes raw profiles to the ProfileGenerate
//   pattern;
// - annotation from the indexed ProfileUse profile, and from its
//   context-sensitive counts after inlining when it has them;
// - with both, annotation from ProfileUse and a second instrumentation after
//   inlining that writes context-sensitive counts to the ProfileGenerate
//   pattern. `scriptc merge-profiles` adds them to the first profile.
// Functions the profile does not describe, or whose control flow changed
// since it was collected, are optimized as without one, so a stale profile
// loses only its gain.
std::optional<PGOOptions> profileOptions(const EmitOptions &Options) {
  if (!Options.ProfileGenerate.empty() && !Options.ProfileUse.empty())
    return PGOOptions(Options.ProfileUse, Options.ProfileGenerate, "", "",
                      PGOOptions::IRUse, PGOOptions::CSIRInstr);
  if (!Options.ProfileGenerate.empty())
    return PGOOptions(Options.ProfileGenerate, "", "", "",
                      PGOOptions::IRInstr);
  if (!Options.ProfileUse.empty())
    return PGOOptions(Options.ProfileUse, "", "", "", PGOOptions::IRUse,
                      ContextProfile ? PGOOptions::CSIRUse
                                     : PGOOptions::NoCSAction);
  return std::nullopt;
}

// Block placement by the extended TSP model, which needs the exact block
// counts a context-sensitive profile gives. The option is process-wide; the
// helper sets it once.
void enableExtTspPlacement() {
  static const bool Enabled = [] {
    if (cl::Option *Option = cl::getRegisteredOptions().lookup(
            "enable-ext-tsp-block-placement"))
      Option->addOccurrence(0, "enable-ext-tsp-block-placement", "true");
    return true;
  }();
  (void)Enabled;
}

// With a profile, the thin link imports the callees of hot call edges up to
// 10 times, and of the hottest edges up to 100 times, the usual size limit,
// into every partition that calls them. On large programs that triples the
// build's time and memory for no measurable run-time gain over a much smaller
// allowance, so profile builds use that one. The importer's limits are
// process-wide options; the helper sets them once.
void limitProfileImports() {
  static const bool Limited = [] {
    auto Registered = cl::getRegisteredOptions();
    for (StringRef Name :
         {"import-hot-multiplier", "import-critical-multiplier"})
      if (cl::Option *Option = Registered.lookup(Name))
        Option->addOccurrence(0, Name, ProfileImportMultiplier);
    return true;
  }();
  (void)Limited;
}

// The thin link imports a callee of up to 100 instructions, LLVM's default,
// into every partition that calls it, and each partition then optimizes and
// compiles its imported copies again. On tsc-ts (64 partitions) a limit of 40
// takes about 7% off the helper's time, and the program runs as fast; 30 and
// below made it run 1-8% slower. The limit is a process-wide option; the
// helper sets it once.
void limitImports() {
  static const bool Limited = [] {
    if (cl::Option *Option =
            cl::getRegisteredOptions().lookup("import-instr-limit"))
      Option->addOccurrence(0, "import-instr-limit", ImportInstructionLimit);
    return true;
  }();
  (void)Limited;
}

// Drops the names of a partition's struct types before its summary is
// written. Every partition declares the program's types under the same
// names, and a thin link loads the importing partition and the partitions
// it imports from into one context, which tells same-named types apart by
// appending a counter that runs across the whole link. An edit that adds a
// type anywhere shifts the counter, so the module after importing, the
// object cache key, changed in partitions whose code had not. Unnamed types
// carry no such suffix; importing still matches them by their bodies.
struct UnnameStructTypes : PassInfoMixin<UnnameStructTypes> {
  PreservedAnalyses run(Module &M, ModuleAnalysisManager &) {
    for (StructType *Type : M.getIdentifiedStructTypes())
      Type->setName("");
    return PreservedAnalyses::all();
  }
  static bool isRequired() { return true; }
};

// How the --profile-use profile matched the functions it annotated, summed
// over partitions: functions that received its counts, functions whose
// control flow changed since it was collected (hash mismatch), and functions
// it has no record of (new since it was collected, or never run in training
// when the profile was merged with --sparse). A partition reused from the cache without its counts is counted
// in Unknown.
struct ProfileMatch {
  std::atomic<uint64_t> Annotated{0};
  std::atomic<uint64_t> Mismatched{0};
  std::atomic<uint64_t> Missing{0};
  std::atomic<uint64_t> Unknown{0};

  void add(const ProfileMatch &Other) {
    Annotated += Other.Annotated;
    Mismatched += Other.Mismatched;
    Missing += Other.Missing;
  }

  std::string serialize() const {
    return formatv("{0} {1} {2}", Annotated.load(), Mismatched.load(),
                   Missing.load())
        .str();
  }

  bool deserialize(StringRef Text) {
    SmallVector<StringRef, 3> Parts;
    Text.split(Parts, ' ');
    uint64_t Values[3];
    if (Parts.size() != 3)
      return false;
    for (size_t I = 0; I < 3; ++I)
      if (Parts[I].getAsInteger(10, Values[I]))
        return false;
    Annotated += Values[0];
    Mismatched += Values[1];
    Missing += Values[2];
    return true;
  }
};

// Counts the profile annotation's hash-mismatch and missing-function
// warnings instead of printing them. Every other diagnostic takes the
// context's default handling.
class ProfileMatchHandler : public DiagnosticHandler {
public:
  explicit ProfileMatchHandler(ProfileMatch &Match) : Match(Match) {}

  bool handleDiagnostics(const DiagnosticInfo &Info) override {
    if (Info.getKind() != DK_PGOProfile)
      return false;
    std::string Message;
    raw_string_ostream Stream(Message);
    DiagnosticPrinterRawOStream Printer(Stream);
    Info.print(Printer);
    if (StringRef(Message).contains("hash mismatch"))
      ++Match.Mismatched;
    else if (StringRef(Message).contains_insensitive("no profile data"))
      ++Match.Missing;
    else
      return false;
    return true;
  }

private:
  ProfileMatch &Match;
};

// The annotation warns about functions the profile does not describe only
// when asked; the match counts need those warnings. Process-wide, set once.
void reportMissingProfiles() {
  static const bool Reported = [] {
    if (cl::Option *Option =
            cl::getRegisteredOptions().lookup("pgo-warn-missing-function"))
      Option->addOccurrence(0, "pgo-warn-missing-function", "true");
    return true;
  }();
  (void)Reported;
}

// Functions of `M` that the profile annotated with counts.
uint64_t annotatedFunctions(const Module &M) {
  uint64_t Count = 0;
  for (const Function &F : M) {
    if (F.isDeclaration())
      continue;
    std::optional<Function::ProfileCount> Entry = F.getEntryCount();
    if (Entry && !Entry->isSynthetic())
      ++Count;
  }
  return Count;
}

// Prints the profile match as the successful emit's one line of JSON.
void reportProfileMatch(const ProfileMatch &Match) {
  json::Object Profile{{"annotated", Match.Annotated.load()},
                       {"mismatched", Match.Mismatched.load()},
                       {"missing", Match.Missing.load()},
                       {"unknown_partitions", Match.Unknown.load()}};
  json::Object Response{{"ok", true}, {"profile", std::move(Profile)}};
  outs() << formatv("{0}\n", json::Value(std::move(Response)));
}

// Reads the profile's header once, before any partition needs it: it must
// hold IR-level counts. Context-sensitive counts lay out the code by them;
// a profile that has them cannot take a second set.
std::optional<EmitFailure> inspectProfile(const EmitOptions &Options) {
  if (Options.ProfileUse.empty())
    return std::nullopt;
  Expected<std::unique_ptr<IndexedInstrProfReader>> Reader =
      IndexedInstrProfReader::create(Options.ProfileUse,
                                     *vfs::getRealFileSystem());
  if (!Reader)
    return EmitFailure{"profile_read_failed",
                       Options.ProfileUse + ": " +
                           toString(Reader.takeError())};
  if (!(*Reader)->isIRLevelProfile())
    return EmitFailure{"profile_read_failed",
                       Options.ProfileUse +
                           ": not an IR-level instrumentation profile"};
  ContextProfile = (*Reader)->hasCSIRLevelProfile();
  if (ContextProfile && !Options.ProfileGenerate.empty())
    return EmitFailure{"profile_read_failed",
                       Options.ProfileUse +
                           ": already holds context-sensitive counts; "
                           "collect them on top of the IR-level profile"};
  if (ContextProfile && Triple(Options.Target).isOSBinFormatELF()) {
    enableProfileLayout();
    enableExtTspPlacement();
  }
  return std::nullopt;
}

// Owns the analysis managers a pipeline needs for one module.
struct Pipeline {
  PassInstrumentationCallbacks Callbacks;
  LoopAnalysisManager LAM;
  FunctionAnalysisManager FAM;
  CGSCCAnalysisManager CGAM;
  ModuleAnalysisManager MAM;
  PassBuilder PB;

  Pipeline(TargetMachine &Machine, OptimizationLevel Level,
           std::optional<PGOOptions> Profile = std::nullopt)
      : PB(&Machine, tuningFor(Level), std::move(Profile), &Callbacks) {
    PB.registerModuleAnalyses(MAM);
    PB.registerCGSCCAnalyses(CGAM);
    PB.registerFunctionAnalyses(FAM);
    PB.registerLoopAnalyses(LAM);
    PB.crossRegisterProxies(LAM, FAM, CGAM, MAM);
  }

  // Adds to Count the functions the profile annotation gave counts to, as
  // soon as that pass has run: inlining and dead code elimination later in
  // the pipeline delete annotated functions.
  void countAnnotated(std::atomic<uint64_t> &Count) {
    Callbacks.registerAfterPassCallback(
        [&Count](StringRef PassID, Any IR, const PreservedAnalyses &) {
          if (PassID != "PGOInstrumentationUse")
            return;
          if (const auto *M = llvm::any_cast<const Module *>(&IR))
            Count += annotatedFunctions(**M);
        });
  }
};

std::optional<EmitFailure> verify(Module &M, StringRef Code) {
  std::string Error;
  raw_string_ostream Stream(Error);
  if (verifyModule(M, &Stream))
    return EmitFailure{Code.str(), Stream.str()};
  return std::nullopt;
}

// Runs WebAssembly's pass that gives multiple-entry loops a single entry only
// on functions that have such a loop. The pass first records, for every
// block, every block it can reach, so its time and memory grow with the
// square of the block count even when it changes nothing: a module
// initializer of 40,000 blocks took four minutes and 22 GB in it. It changes
// a function only when two loop entries can reach each other, which a
// reducible control flow graph never has, so skipping reducible functions
// leaves the output unchanged.
class IrreducibleControlFlowOnly final : public MachineFunctionPass {
public:
  static char ID;

  explicit IrreducibleControlFlowOnly(FunctionPass *Fix)
      : MachineFunctionPass(ID), Fix(Fix) {}

  StringRef getPassName() const override { return Fix->getPassName(); }

  bool doInitialization(Module &M) override {
    MachineFunctionPass::doInitialization(M);
    return Fix->doInitialization(M);
  }

  bool doFinalization(Module &M) override { return Fix->doFinalization(M); }

  void getAnalysisUsage(AnalysisUsage &Usage) const override {
    Fix->getAnalysisUsage(Usage);
  }

  bool runOnMachineFunction(MachineFunction &MF) override {
    if (isReducible(MF))
      return false;
    // The wrapped pass reads the machine function through the module's
    // machine code analysis, which this pass requires on its behalf.
    if (Fix->getResolver() == nullptr) {
      auto *Resolver = new AnalysisResolver(getResolver()->getPMDataManager());
      Resolver->addAnalysisImplsPair(
          &MachineModuleInfoWrapperPass::ID,
          &getAnalysis<MachineModuleInfoWrapperPass>());
      Fix->setResolver(Resolver);
    }
    return Fix->runOnFunction(MF.getFunction());
  }

private:
  // A graph is reducible when every edge that a depth-first search finds
  // going back to a block on its stack targets a block that dominates the
  // edge's source. Blocks the entry cannot reach count as irreducible, since
  // the wrapped pass also examines them.
  static bool isReducible(MachineFunction &MF) {
    MachineDominatorTree Dominators(MF);
    enum class State : unsigned char { New, Active, Done };
    std::vector<State> States(MF.getNumBlockIDs(), State::New);
    SmallVector<std::pair<MachineBasicBlock *,
                          MachineBasicBlock::succ_iterator>,
                32>
        Stack;
    size_t Visited = 1;
    MachineBasicBlock *Entry = &MF.front();
    States[Entry->getNumber()] = State::Active;
    Stack.push_back({Entry, Entry->succ_begin()});
    while (!Stack.empty()) {
      auto &[Block, Next] = Stack.back();
      if (Next == Block->succ_end()) {
        States[Block->getNumber()] = State::Done;
        Stack.pop_back();
        continue;
      }
      MachineBasicBlock *Successor = *Next++;
      State &Seen = States[Successor->getNumber()];
      if (Seen == State::Active) {
        if (!Dominators.dominates(Successor, Block))
          return false;
      } else if (Seen == State::New) {
        Seen = State::Active;
        ++Visited;
        Stack.push_back({Successor, Successor->succ_begin()});
      }
    }
    return Visited == MF.size();
  }

  std::unique_ptr<FunctionPass> Fix;
};

char IrreducibleControlFlowOnly::ID = 0;

// The code generation pipeline for one module, with two changes for
// WebAssembly. The irreducible control flow pass runs only where it can
// change the function (see IrreducibleControlFlowOnly). Object emission also
// leaves out the last machine pass, a module pass that records the external
// symbols every function uses so that assembly output can declare them
// before the first function. A module pass in the middle of the pipeline
// keeps the machine code of every function alive until all of them are
// compiled. Object files do not contain those declarations, and the printer
// creates each symbol when it lowers the first use, so without the pass each
// function's machine code is freed once it is printed.
class CodeGenPasses final : public legacy::PassManagerBase {
public:
  CodeGenPasses(const TargetMachine &Machine, CodeGenFileType Type)
      : Wasm(Machine.getTargetTriple().isWasm()),
        Object(Type == CodeGenFileType::ObjectFile) {}

  void add(Pass *P) override {
    if (Wasm) {
      StringRef Argument = passArgument(*P);
      if (Argument == "wasm-fix-irreducible-control-flow") {
        Passes.add(
            new IrreducibleControlFlowOnly(static_cast<FunctionPass *>(P)));
        return;
      }
      if (Object && Argument == "wasm-mclower-prepass") {
        delete P;
        return;
      }
    }
    Passes.add(P);
  }

  void run(Module &M) { Passes.run(M); }

private:
  static StringRef passArgument(const Pass &P) {
    const PassInfo *Info =
        PassRegistry::getPassRegistry()->getPassInfo(P.getPassID());
    return Info == nullptr ? StringRef() : Info->getPassArgument();
  }

  bool Wasm;
  bool Object;
  legacy::PassManager Passes;
};

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
  CodeGenPasses CodeGeneration(Machine, Type);
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
           std::optional<PGOOptions> Profile, CodeGenFileType Type,
           StringRef OutputPath, std::vector<SmallString<256>> &Temporaries,
           ProfileMatch &Match) {
  bool Annotating = Profile && Profile->Action == PGOOptions::IRUse;
  if (Annotating)
    M.getContext().setDiagnosticHandler(
        std::make_unique<ProfileMatchHandler>(Match));
  Pipeline P(Machine, Level, std::move(Profile));
  if (Annotating)
    P.countAnnotated(Match.Annotated);
  P.PB.buildPerModuleDefaultPipeline(Level).run(M, P.MAM);
  if (std::optional<EmitFailure> Failure =
          verify(M, "post_optimization_verification_failed"))
    return Failure;
  return generateCode(M, Machine, Type, OutputPath, Temporaries);
}

// Bytes of each partition's module, as LLVM assembly or bitcode, plus the
// names of definitions that were externally visible before partitioning.
struct PartitionPlan {
  std::vector<std::string> Modules;
  StringSet<> PublicSymbols;
};

// Fallback when the input is outside the text partitioner's grammar: parse
// the whole module once and split it with LLVM, which makes every local
// definition hidden so partitions can reference each other.
std::optional<EmitFailure> splitParsedModule(const EmitOptions &Options,
                                             PartitionPlan &Plan) {
  SMDiagnostic ParseDiagnostic;
  LLVMContext Context;
  std::unique_ptr<Module> Mod =
      parseIRFile(Options.Input, ParseDiagnostic, Context);
  if (!Mod) {
    std::string Detail;
    raw_string_ostream Stream(Detail);
    ParseDiagnostic.print("scriptc-llvm-codegen", Stream);
    return EmitFailure{"invalid_ir", Stream.str()};
  }
  if (std::optional<EmitFailure> Failure = verify(*Mod, "verification_failed"))
    return Failure;
  for (const GlobalValue &GV : Mod->global_values())
    if (!GV.isDeclaration() && !GV.hasLocalLinkage())
      Plan.PublicSymbols.insert(GV.getName());
  SplitModule(*Mod, static_cast<unsigned>(Options.Outputs.size()),
              [&](std::unique_ptr<Module> Partition) {
                Plan.Modules.emplace_back();
                raw_string_ostream Stream(Plan.Modules.back());
                WriteBitcodeToFile(*Partition, Stream);
              });
  if (Plan.Modules.size() != Options.Outputs.size())
    return EmitFailure{"partition_failed", "LLVM produced an unexpected number "
                                           "of program partitions"};
  return std::nullopt;
}

// Runs Work(I) for every partition on a pool sized to the host. Outputs never
// depend on the pool size or scheduling order.
void forEachPartition(size_t Count, function_ref<void(size_t)> Work) {
  DefaultThreadPool Pool(hardware_concurrency());
  for (size_t I = 0; I < Count; ++I)
    Pool.async([&Work, I] { Work(I); });
  Pool.wait();
}

class SharedFailure {
public:
  void set(EmitFailure Failure) {
    std::lock_guard<std::mutex> Lock(Mutex);
    if (!First)
      First = std::move(Failure);
  }
  std::optional<EmitFailure> take() { return std::move(First); }

private:
  std::mutex Mutex;
  std::optional<EmitFailure> First;
};

// Parses one partition into its own context with the requested target.
Expected<std::unique_ptr<Module>> loadPartition(const EmitOptions &Options,
                                                StringRef Bytes, size_t Index,
                                                LLVMContext &Context,
                                                TargetMachine &Machine) {
  SMDiagnostic Diagnostic;
  std::string Name = "partition-" + std::to_string(Index);
  std::unique_ptr<Module> Mod =
      parseIR(MemoryBufferRef(Bytes, Name), Diagnostic, Context);
  if (!Mod) {
    std::string Detail;
    raw_string_ostream Stream(Detail);
    Diagnostic.print("scriptc-llvm-codegen", Stream);
    return createStringError(inconvertibleErrorCode(), Stream.str());
  }
  if (!Options.SourcePath.empty())
    Mod->setSourceFileName(Options.SourcePath);
  Mod->setTargetTriple(Triple(Options.Target));
  Mod->setDataLayout(Machine.createDataLayout());
  if (std::optional<EmitFailure> Failure = verify(*Mod, "verification_failed"))
    return createStringError(inconvertibleErrorCode(), Failure->Message);
  return std::move(Mod);
}

// A raw_ostream that only hashes what is written to it.
class HashingStream : public raw_ostream {
public:
  explicit HashingStream(SHA256 &Hash) : Hash(Hash) { SetUnbuffered(); }

private:
  void write_impl(const char *Data, size_t Size) override {
    Hash.update(StringRef(Data, Size));
    Position += Size;
  }
  uint64_t current_pos() const override { return Position; }
  SHA256 &Hash;
  uint64_t Position = 0;
};

// Collects one native object per partition in memory.
class ObjectStream : public CachedFileStream {
public:
  explicit ObjectStream(SmallVector<char, 0> &Buffer)
      : CachedFileStream(std::make_unique<raw_svector_ostream>(Buffer)) {}
};

// Unoptimized partitions are independent: each compiles, or comes from the
// cache keyed by its exact source, on its own thread.
std::optional<EmitFailure>
compileUnoptimizedPartitions(const EmitOptions &Options,
                             const PartitionPlan &Plan, StringRef Salt,
                             const ArtifactCache &Cache,
                             std::vector<SmallVector<char, 0>> &Objects) {
  SharedFailure Failures;
  forEachPartition(Plan.Modules.size(), [&](size_t I) {
    std::string Key = hashParts({Salt, "object", Plan.Modules[I]});
    if (std::unique_ptr<MemoryBuffer> Hit = Cache.lookup(Key, "o")) {
      Objects[I].assign(Hit->getBufferStart(), Hit->getBufferEnd());
      return;
    }
    std::string LookupError;
    std::unique_ptr<TargetMachine> Machine =
        createTargetMachine(Options.Target, Options.OptLevel, LookupError);
    if (!Machine)
      return Failures.set({"target_machine_failed", LookupError});
    LLVMContext Context;
    Expected<std::unique_ptr<Module>> Mod =
        loadPartition(Options, Plan.Modules[I], I, Context, *Machine);
    if (!Mod)
      return Failures.set({"partition_failed", toString(Mod.takeError())});
    // The O0 pipeline still lowers coroutines and always-inline calls.
    Pipeline P(*Machine, OptimizationLevel::O0, profileOptions(Options));
    P.PB.buildPerModuleDefaultPipeline(OptimizationLevel::O0)
        .run(**Mod, P.MAM);
    raw_svector_ostream Output(Objects[I]);
    CodeGenPasses CodeGeneration(*Machine, CodeGenFileType::ObjectFile);
    if (Machine->addPassesToEmitFile(CodeGeneration, Output, nullptr,
                                     CodeGenFileType::ObjectFile))
      return Failures.set({"emission_not_supported",
                           "target does not support object emission"});
    CodeGeneration.run(**Mod);
    Cache.store(Key, "o", StringRef(Objects[I].data(), Objects[I].size()));
  });
  return Failures.take();
}

// Optimized partitions follow the ThinLTO model. Each partition is simplified
// on its own thread and summarized; a thin link over the summaries decides
// which small functions every partition imports from the others for
// inlining and which promoted symbols return to internal linkage; then each
// partition is optimized and compiled on its own thread. Simplified bitcode
// is cached by the partition's exact source, and objects by the exact module
// after importing, so an edit recompiles only the partitions it can affect.
std::optional<EmitFailure>
compileOptimizedPartitions(const EmitOptions &Options,
                           const PartitionPlan &Plan, OptimizationLevel Level,
                           StringRef Salt, const ArtifactCache &Cache,
                           std::vector<SmallVector<char, 0>> &Objects,
                           ProfileMatch &Match) {
  size_t Count = Plan.Modules.size();
  bool Annotating = !Options.ProfileUse.empty();
  std::vector<std::unique_ptr<MemoryBuffer>> Summaries(Count);
  SharedFailure Failures;
  forEachPartition(Count, [&](size_t I) {
    std::string Key = hashParts({Salt, "summary", Plan.Modules[I]});
    if ((Summaries[I] = Cache.lookup(Key, "bc"))) {
      if (Annotating) {
        std::unique_ptr<MemoryBuffer> Counts = Cache.lookup(Key, "match");
        if (!Counts || !Match.deserialize(Counts->getBuffer()))
          ++Match.Unknown;
      }
      return;
    }
    std::string LookupError;
    std::unique_ptr<TargetMachine> Machine =
        createTargetMachine(Options.Target, Options.OptLevel, LookupError);
    if (!Machine)
      return Failures.set({"target_machine_failed", LookupError});
    LLVMContext Context;
    ProfileMatch PartitionMatch;
    if (Annotating)
      Context.setDiagnosticHandler(
          std::make_unique<ProfileMatchHandler>(PartitionMatch));
    Expected<std::unique_ptr<Module>> Loaded =
        loadPartition(Options, Plan.Modules[I], I, Context, *Machine);
    if (!Loaded)
      return Failures.set({"partition_failed", toString(Loaded.takeError())});
    Module &Mod = **Loaded;
    if (!Options.ImportBitcode.empty()) {
      // See emit(): the attribute is inert without a sanitizer pass and
      // would block inlining of the imported runtime bodies.
      for (Function &F : Mod)
        F.removeFnAttr(Attribute::SanitizeAddress);
      if (std::optional<std::string> Error =
              importRuntimeBitcode(Mod, Options.ImportBitcode))
        return Failures.set({"runtime_import_failed", *Error});
      if (std::optional<EmitFailure> Failure =
              verify(Mod, "runtime_import_verification_failed"))
        return Failures.set(std::move(*Failure));
    }
    SmallVector<char, 0> Bitcode;
    {
      raw_svector_ostream Stream(Bitcode);
      // Profile instrumentation or annotation happens here, before the thin
      // link; the post-link optimization reads the annotated weights.
      Pipeline P(*Machine, Level, profileOptions(Options));
      if (Annotating)
        P.countAnnotated(PartitionMatch.Annotated);
      ModulePassManager MPM = P.PB.buildThinLTOPreLinkDefaultPipeline(Level);
      MPM.addPass(UnnameStructTypes());
      MPM.addPass(BitcodeWriterPass(Stream, /*ShouldPreserveUseListOrder=*/false,
                                    /*EmitSummaryIndex=*/true,
                                    /*EmitModuleHash=*/true));
      MPM.run(Mod, P.MAM);
    }
    if (Annotating) {
      Match.add(PartitionMatch);
      // Stored before the summary, so a reused summary finds its counts.
      Cache.store(Key, "match", PartitionMatch.serialize());
    }
    StringRef Contents(Bitcode.data(), Bitcode.size());
    Cache.store(Key, "bc", Contents);
    Summaries[I] = MemoryBuffer::getMemBufferCopy(Contents);
  });
  if (std::optional<EmitFailure> Failure = Failures.take())
    return Failure;

  lto::Config Config;
  Triple TargetTriple(Options.Target);
  Config.CPU = "generic";
  Config.Options = targetOptions(TargetTriple);
  Config.RelocModel = Reloc::PIC_;
  Config.CodeModel = CodeModel::Small;
  Config.CGOptLevel = codeGenLevel(Options.OptLevel);
  Config.OptLevel = Level == OptimizationLevel::O1   ? 1
                    : Level == OptimizationLevel::O3 ? 3
                                                     : 2;
  Config.PTO = tuningFor(Level);
  // The thin backend instruments or annotates context-sensitive counts after
  // its inlining (see profileOptions).
  if (!Options.ProfileGenerate.empty() && !Options.ProfileUse.empty()) {
    Config.RunCSIRInstr = true;
    Config.CSIRProfile = Options.ProfileGenerate;
  } else if (ContextProfile) {
    Config.CSIRProfile = Options.ProfileUse;
  }
  Config.CGFileType = CodeGenFileType::ObjectFile;
  Config.DefaultTriple = Options.Target;
  Config.DiagHandler = [&](const DiagnosticInfo &Info) {
    if (Info.getSeverity() != DS_Error)
      return;
    std::string Message;
    raw_string_ostream Stream(Message);
    DiagnosticPrinterRawOStream Printer(Stream);
    Info.print(Printer);
    Failures.set({"partition_failed", Stream.str()});
  };
  std::vector<std::string> ObjectKeys(Count);
  Config.PostImportModuleHook = [&](unsigned Task, const Module &Mod) {
    size_t I = Task - 1;
    if (I >= Count)
      return true;
    SHA256 Hash;
    {
      HashingStream Stream(Hash);
      WriteBitcodeToFile(Mod, Stream);
    }
    std::string Key =
        hashParts({Salt, "object", toHex(Hash.final(), /*LowerCase=*/true)});
    if (std::unique_ptr<MemoryBuffer> Hit = Cache.lookup(Key, "o")) {
      Objects[I].assign(Hit->getBufferStart(), Hit->getBufferEnd());
      return false;
    }
    ObjectKeys[I] = std::move(Key);
    return true;
  };

  // The backend's own code generation cannot use CodeGenPasses, so
  // WebAssembly partitions are compiled here with the passes it would add,
  // and returning false skips it.
  if (TargetTriple.isWasm())
    Config.PreCodeGenModuleHook = [&](unsigned Task, const Module &Optimized) {
      size_t I = Task - 1;
      if (I >= Count)
        return true;
      std::string LookupError;
      std::unique_ptr<TargetMachine> Machine =
          createTargetMachine(Options.Target, Options.OptLevel, LookupError);
      if (!Machine) {
        Failures.set({"target_machine_failed", LookupError});
        return false;
      }
      // The backend passes the module it owns; only the hook's signature is
      // const.
      Module &Mod = const_cast<Module &>(Optimized);
      Objects[I].clear();
      raw_svector_ostream Output(Objects[I]);
      CodeGenPasses CodeGeneration(*Machine, CodeGenFileType::ObjectFile);
      TargetLibraryInfoImpl LibraryInfo(Mod.getTargetTriple(),
                                        Machine->Options.VecLib);
      CodeGeneration.add(new TargetLibraryInfoWrapperPass(LibraryInfo));
      CodeGeneration.add(new RuntimeLibraryInfoWrapper(
          Mod.getTargetTriple(), Machine->Options.ExceptionModel,
          Machine->Options.FloatABIType, Machine->Options.EABIVersion,
          Machine->Options.MCOptions.ABIName, Machine->Options.VecLib));
      if (Machine->addPassesToEmitFile(CodeGeneration, Output, nullptr,
                                       CodeGenFileType::ObjectFile)) {
        Failures.set({"emission_not_supported",
                      "target does not support object emission"});
        return false;
      }
      CodeGeneration.run(Mod);
      return false;
    };

  // The link refers to module identifiers for its whole lifetime.
  std::vector<std::string> Names(Count);
  for (size_t I = 0; I < Count; ++I)
    Names[I] = "partition-" + std::to_string(I);
  limitImports();
  if (!Options.ProfileUse.empty())
    limitProfileImports();
  lto::LTO Link(std::move(Config),
                lto::createInProcessThinBackend(hardware_concurrency()));
  // Profile instrumentation gives every partition its own weak copy of the
  // variables the profile runtime reads (the profile format and file name).
  // One copy prevails and stays visible so the runtime's defaults do not.
  StringSet<> ProfileSymbols;
  for (size_t I = 0; I < Count; ++I) {
    Expected<std::unique_ptr<lto::InputFile>> Input = lto::InputFile::create(
        MemoryBufferRef(Summaries[I]->getBuffer(), Names[I]));
    if (!Input)
      return EmitFailure{"partition_failed", toString(Input.takeError())};
    std::vector<lto::SymbolResolution> Resolutions;
    for (const lto::InputFile::Symbol &Symbol : (*Input)->symbols()) {
      lto::SymbolResolution Resolution;
      if (!Symbol.isUndefined()) {
        // Partitions define disjoint symbols. Only definitions that were
        // external before partitioning are visible to the runtime objects
        // linked beside them; the rest may become internal again.
        bool Public = Plan.PublicSymbols.contains(Symbol.getIRName());
        bool Profile = Symbol.getIRName().starts_with("__llvm_profile_");
        if (Profile)
          Public = ProfileSymbols.insert(Symbol.getIRName()).second;
        Resolution.Prevailing = !Profile || Public;
        Resolution.VisibleToRegularObj = Public;
        Resolution.FinalDefinitionInLinkageUnit = !Public;
      }
      Resolutions.push_back(Resolution);
    }
    if (Error Err = Link.add(std::move(*Input), Resolutions))
      return EmitFailure{"partition_failed", toString(std::move(Err))};
  }
  Error Err = Link.run([&](unsigned Task, const Twine &)
                           -> Expected<std::unique_ptr<CachedFileStream>> {
    size_t I = Task - 1;
    if (I >= Count)
      return createStringError(inconvertibleErrorCode(),
                               "unexpected regular LTO output");
    Objects[I].clear();
    return std::make_unique<ObjectStream>(Objects[I]);
  });
  if (Err)
    return EmitFailure{"partition_failed", toString(std::move(Err))};
  if (std::optional<EmitFailure> Failure = Failures.take())
    return Failure;
  for (size_t I = 0; I < Count; ++I)
    if (!ObjectKeys[I].empty())
      Cache.store(ObjectKeys[I], "o",
                  StringRef(Objects[I].data(), Objects[I].size()));
  return std::nullopt;
}

std::optional<EmitFailure>
compilePartitions(const EmitOptions &Options, const PartitionPlan &Plan,
                  std::vector<SmallVector<char, 0>> &Objects,
                  ProfileMatch &Match) {
  // Everything besides a partition's own bytes that determines its
  // artifacts. The caller's cache directory already identifies the exact
  // helper build; source content and partition count arrive per module.
  std::string Salt = hashParts({"scriptc-partition-v1", LLVM_VERSION_STRING,
                                Options.Target, Options.OptLevel,
                                Options.RelocationModel, Options.SourcePath,
                                "profile-generate", Options.ProfileGenerate});
  // A profile changes every partition it describes, so its bytes key them.
  if (!Options.ProfileUse.empty()) {
    ErrorOr<std::unique_ptr<MemoryBuffer>> Profile =
        MemoryBuffer::getFile(Options.ProfileUse, /*IsText=*/false,
                              /*RequiresNullTerminator=*/false);
    if (!Profile)
      return EmitFailure{"profile_read_failed",
                         Options.ProfileUse + ": " +
                             Profile.getError().message()};
    Salt = hashParts({Salt, "profile-use", (*Profile)->getBuffer()});
  }
  for (const std::string &Path : Options.ImportBitcode) {
    ErrorOr<std::unique_ptr<MemoryBuffer>> Bitcode =
        MemoryBuffer::getFile(Path, /*IsText=*/false,
                              /*RequiresNullTerminator=*/false);
    if (!Bitcode)
      return EmitFailure{"runtime_import_failed",
                         Path + ": " + Bitcode.getError().message()};
    Salt = hashParts({Salt, (*Bitcode)->getBuffer()});
  }
  ArtifactCache Cache(Options.CacheDirectory);
  Objects.assign(Plan.Modules.size(), {});
  if (Options.OptLevel == "0")
    return compileUnoptimizedPartitions(Options, Plan, Salt, Cache, Objects);
  return compileOptimizedPartitions(Options, Plan,
                                    optimizationLevel(Options.OptLevel), Salt,
                                    Cache, Objects, Match);
}

// Publishes in-memory partition objects through private sibling files.
std::optional<EmitFailure>
writePartitionObjects(const EmitOptions &Options,
                      const std::vector<SmallVector<char, 0>> &Objects,
                      std::vector<SmallString<256>> &Temporaries) {
  for (size_t I = 0; I < Objects.size(); ++I) {
    SmallString<256> TemporaryPath(Options.Outputs[I]);
    TemporaryPath.append(".tmp-%%%%%%");
    int TemporaryFd = -1;
    if (std::error_code EC = sys::fs::createUniqueFile(
            TemporaryPath, TemporaryFd, TemporaryPath))
      return EmitFailure{"output_open_failed", EC.message()};
    Temporaries.push_back(TemporaryPath);
    raw_fd_ostream Output(TemporaryFd, true);
    Output.write(Objects[I].data(), Objects[I].size());
    Output.close();
    if (Output.has_error()) {
      std::string Message = Output.error().message();
      Output.clear_error();
      return EmitFailure{"output_write_failed", Message};
    }
  }
  return std::nullopt;
}

// Several outputs: divide the program into that many partitions, then
// compile them concurrently. The division is a deterministic function of the
// module and the partition count, so output never depends on host
// parallelism. Splitting the assembly text lets partitions parse
// concurrently; any input outside the text partitioner's grammar, or a
// partition it produced that does not load, falls back to LLVM's splitter.
int emitPartitions(const EmitOptions &Options) {
  // Every partition may come from the cache, so the optimizer's target
  // lookups cannot rely on an earlier target machine having registered it.
  initializeTargets();
  std::vector<SmallVector<char, 0>> Objects;
  std::optional<EmitFailure> Failure;
  bool Compiled = false;
  // A failed attempt's counts are discarded with its objects.
  auto Match = std::make_unique<ProfileMatch>();
  {
    ErrorOr<std::unique_ptr<MemoryBuffer>> Input =
        MemoryBuffer::getFile(Options.Input, /*IsText=*/false,
                              /*RequiresNullTerminator=*/false);
    if (Input) {
      std::optional<ProgramPartitions> Text = partitionProgramText(
          (*Input)->getBuffer(), static_cast<unsigned>(Options.Outputs.size()));
      if (Text) {
        Input->reset();
        PartitionPlan Plan{std::move(Text->Sources),
                           std::move(Text->PublicSymbols)};
        Compiled = !compilePartitions(Options, Plan, Objects, *Match);
      }
    }
  }
  if (!Compiled) {
    Match = std::make_unique<ProfileMatch>();
    PartitionPlan Plan;
    Failure = splitParsedModule(Options, Plan);
    if (!Failure)
      Failure = compilePartitions(Options, Plan, Objects, *Match);
  }
  std::vector<SmallString<256>> Temporaries;
  if (!Failure)
    Failure = writePartitionObjects(Options, Objects, Temporaries);
  for (size_t I = 0; !Failure && I < Temporaries.size(); ++I)
    Failure = publish(Temporaries[I], Options.Outputs[I]);
  if (Failure) {
    for (const SmallString<256> &Temporary : Temporaries)
      sys::fs::remove(Temporary);
    return reportError(Failure->Code, Failure->Message,
                       Options.DiagnosticFormat);
  }
  if (!Options.ProfileUse.empty())
    reportProfileMatch(*Match);
  return 0;
}

// An optimized module prepared for split code generation.
struct CodegenSplit {
  // The module as bitcode, with the order of every use list.
  SmallVector<char, 0> Bitcode;
  // The output that holds each definition, by name.
  StringMap<size_t> PartOf;
};

// Divides an optimized module's definitions among Count outputs for code
// generation. Functions are divided in module order into runs of about the
// same instruction count, so linking the outputs in order lays the functions
// out as one module would; a function that would take its run past an even
// share starts the next run. A local definition that another output uses
// becomes hidden so the outputs can reference each other; the others stay
// local. Variables and aliases go with output 0 unless a comdat, an aliasee
// or an ifunc resolver places them. When one run would hold more than three
// quarters of the instructions, dividing cannot shorten code generation: the
// result is empty and M is unchanged. Placement depends only on the module.
std::optional<CodegenSplit> splitForCodegen(Module &M, size_t Count) {
  uint64_t Total = 0;
  for (const Function &F : M)
    if (!F.isDeclaration())
      Total += F.getInstructionCount() + 1;
  DenseMap<const GlobalValue *, size_t> Part;
  DenseMap<const Comdat *, size_t> ComdatPart;
  std::vector<uint64_t> Load(Count, 0);
  uint64_t Share = (Total + Count - 1) / Count;
  size_t Current = 0;
  uint64_t InRun = 0;
  for (Function &F : M) {
    if (F.isDeclaration())
      continue;
    uint64_t Size = F.getInstructionCount() + 1;
    if (InRun > 0 && InRun + Size > Share && Current + 1 < Count) {
      ++Current;
      InRun = 0;
    }
    size_t Target = Current;
    if (const Comdat *C = F.getComdat()) {
      auto [It, Inserted] = ComdatPart.try_emplace(C, Target);
      Target = It->second;
    }
    Part[&F] = Target;
    Load[Target] += Size;
    InRun += Size;
  }
  if (*std::max_element(Load.begin(), Load.end()) * 4 > Total * 3)
    return std::nullopt;
  auto PartOf = [&](const GlobalValue *GV) -> size_t {
    if (const GlobalObject *Root = GV->getAliaseeObject()) {
      if (const auto *IFunc = dyn_cast<GlobalIFunc>(Root))
        Root = IFunc->getResolverFunction();
      if (Root != nullptr && Root != GV)
        GV = Root;
    }
    if (auto It = Part.find(GV); It != Part.end())
      return It->second;
    if (const auto *GO = dyn_cast<GlobalObject>(GV))
      if (const Comdat *C = GO->getComdat())
        if (auto It = ComdatPart.find(C); It != ComdatPart.end())
          return It->second;
    return 0;
  };
  // Whether a user of GV, through any constants, lies outside output Home.
  auto UsedElsewhere = [&](const GlobalValue &GV, size_t Home) {
    SmallVector<const User *, 8> Work(GV.users());
    SmallPtrSet<const User *, 8> Seen;
    while (!Work.empty()) {
      const User *U = Work.pop_back_val();
      if (!Seen.insert(U).second)
        continue;
      if (const auto *I = dyn_cast<Instruction>(U)) {
        if (PartOf(I->getFunction()) != Home)
          return true;
      } else if (const auto *G = dyn_cast<GlobalValue>(U)) {
        if (PartOf(G) != Home)
          return true;
      } else {
        append_range(Work, U->users());
      }
    }
    return false;
  };
  for (GlobalValue &GV : M.global_values()) {
    if (GV.hasLocalLinkage() && UsedElsewhere(GV, PartOf(&GV))) {
      GV.setLinkage(GlobalValue::ExternalLinkage);
      GV.setVisibility(GlobalValue::HiddenVisibility);
    }
    if (!GV.hasName())
      GV.setName("scr.split");
  }
  CodegenSplit Split;
  for (const GlobalValue &GV : M.global_values())
    if (!GV.isDeclaration())
      Split.PartOf[GV.getName()] = PartOf(&GV);
  raw_svector_ostream Stream(Split.Bitcode);
  WriteBitcodeToFile(M, Stream, /*ShouldPreserveUseListOrder=*/true);
  return Split;
}

// Reduces P, a copy of the split module, to the definitions of output I:
// the other definitions become declarations, and declarations that nothing
// uses are removed. A declaration nothing uses would still emit an untyped
// undefined symbol for its visibility, which some linkers reject against a
// thread-local definition. Removing definitions keeps the order of the
// remaining uses, so each function of the output reaches code generation
// as it would in the whole module.
void keepCodegenPart(Module &P, const StringMap<size_t> &PartOf, size_t I) {
  auto Elsewhere = [&](const GlobalValue &GV) {
    auto It = PartOf.find(GV.getName());
    return It != PartOf.end() && It->second != I;
  };
  // Aliases and ifuncs cannot be declarations, so a declaration replaces
  // them.
  SmallVector<GlobalValue *, 4> Indirect;
  for (GlobalAlias &GA : P.aliases())
    if (Elsewhere(GA))
      Indirect.push_back(&GA);
  for (GlobalIFunc &GI : P.ifuncs())
    if (Elsewhere(GI))
      Indirect.push_back(&GI);
  for (GlobalValue *GV : Indirect) {
    GlobalValue *Declaration;
    if (auto *Type = dyn_cast<FunctionType>(GV->getValueType()))
      Declaration = Function::Create(Type, GlobalValue::ExternalLinkage,
                                     GV->getAddressSpace(), "", &P);
    else
      Declaration = new GlobalVariable(
          P, GV->getValueType(), /*isConstant=*/false,
          GlobalValue::ExternalLinkage, nullptr, "", nullptr,
          GV->getThreadLocalMode(), GV->getAddressSpace());
    Declaration->setVisibility(GV->getVisibility());
    Declaration->setDSOLocal(GV->isDSOLocal());
    Declaration->takeName(GV);
    GV->replaceAllUsesWith(Declaration);
    GV->eraseFromParent();
  }
  for (Function &F : P)
    if (!F.isDeclaration() && Elsewhere(F)) {
      F.deleteBody();
      F.setComdat(nullptr);
    }
  for (GlobalVariable &GV : P.globals())
    if (!GV.isDeclaration() && Elsewhere(GV)) {
      GV.setInitializer(nullptr);
      GV.setComdat(nullptr);
      GV.setLinkage(GlobalValue::ExternalLinkage);
    }
  if (I != 0)
    P.setModuleInlineAsm("");
  // Constant expressions that only the removed bodies used remain as users.
  for (GlobalVariable &GV : make_early_inc_range(P.globals()))
    if (GV.isDeclaration()) {
      GV.removeDeadConstantUsers();
      if (GV.use_empty())
        GV.eraseFromParent();
    }
  for (Function &F : make_early_inc_range(P))
    if (F.isDeclaration()) {
      F.removeDeadConstantUsers();
      if (F.use_empty())
        F.eraseFromParent();
    }
}

// Optimizes M whole, as a single output would, then divides its definitions
// among the outputs and generates code for each on its own thread. The first
// output is generated from M with Machine; the others from copies of M read
// back from bitcode, which keeps the order of every use list, so each
// function's code matches a single-output build except where it refers to a
// definition in another output. Placement depends only
// on the optimized module and the output count. When splitForCodegen keeps
// the module whole, the other outputs are empty objects.
std::optional<EmitFailure>
emitSplitCodegen(const EmitOptions &Options, Module &M, TargetMachine &Machine,
                 OptimizationLevel Level, ProfileMatch &Match) {
  bool Annotating = !Options.ProfileUse.empty();
  if (Annotating)
    M.getContext().setDiagnosticHandler(
        std::make_unique<ProfileMatchHandler>(Match));
  {
    Pipeline P(Machine, Level, profileOptions(Options));
    if (Annotating)
      P.countAnnotated(Match.Annotated);
    P.PB.buildPerModuleDefaultPipeline(Level).run(M, P.MAM);
  }
  if (std::optional<EmitFailure> Failure =
          verify(M, "post_optimization_verification_failed"))
    return Failure;
  size_t Count = Options.Outputs.size();
  std::optional<CodegenSplit> Split = splitForCodegen(M, Count);
  std::string Identifier = M.getModuleIdentifier();
  std::string SourceFileName = M.getSourceFileName();
  Triple TargetTriple = M.getTargetTriple();
  DataLayout Layout = M.getDataLayout();
  std::vector<std::vector<SmallString<256>>> Temporaries(Count);
  SharedFailure Failures;
  forEachPartition(Count, [&](size_t I) {
    if (I == 0) {
      if (Split)
        keepCodegenPart(M, Split->PartOf, 0);
      if (std::optional<EmitFailure> Failure =
              generateCode(M, Machine, CodeGenFileType::ObjectFile,
                           Options.Outputs[0], Temporaries[0]))
        Failures.set(std::move(*Failure));
      return;
    }
    std::string LookupError;
    std::unique_ptr<TargetMachine> PartMachine =
        createTargetMachine(Options.Target, Options.OptLevel, LookupError);
    if (!PartMachine)
      return Failures.set({"target_machine_failed", LookupError});
    LLVMContext Context;
    std::unique_ptr<Module> Part;
    if (Split) {
      Expected<std::unique_ptr<Module>> Parsed = parseBitcodeFile(
          MemoryBufferRef(
              StringRef(Split->Bitcode.data(), Split->Bitcode.size()), "part"),
          Context);
      if (!Parsed)
        return Failures.set(
            {"partition_failed", toString(Parsed.takeError())});
      Part = std::move(*Parsed);
      keepCodegenPart(*Part, Split->PartOf, I);
    } else {
      Part = std::make_unique<Module>(Identifier, Context);
      Part->setSourceFileName(SourceFileName);
      Part->setTargetTriple(TargetTriple);
      Part->setDataLayout(Layout);
    }
    if (std::optional<EmitFailure> Failure =
            generateCode(*Part, *PartMachine, CodeGenFileType::ObjectFile,
                         Options.Outputs[I], Temporaries[I]))
      return Failures.set(std::move(*Failure));
  });
  std::optional<EmitFailure> Failure = Failures.take();
  for (size_t I = 0; I < Count && !Failure; ++I)
    Failure = publish(Temporaries[I][0], Options.Outputs[I]);
  if (Failure)
    for (const std::vector<SmallString<256>> &Paths : Temporaries)
      for (const SmallString<256> &Temporary : Paths)
        sys::fs::remove(Temporary);
  return Failure;
}

} // namespace

std::optional<std::string> optimizeModule(Module &M, TargetMachine &Machine,
                                          const std::string &OptLevel,
                                          bool Instrument,
                                          const std::string &ProfileGenerate,
                                          const std::string &ProfileUse,
                                          ModuleProfileMatch &Result) {
  OptimizationLevel Level = optimizationLevel(OptLevel);
  std::optional<PGOOptions> Profile;
  if (Instrument) {
    Profile = PGOOptions(ProfileGenerate, "", "", "", PGOOptions::IRInstr);
  } else if (!ProfileUse.empty()) {
    EmitOptions Inspected;
    Inspected.ProfileUse = ProfileUse;
    if (std::optional<EmitFailure> Failure = inspectProfile(Inspected))
      return Failure->Message;
    reportMissingProfiles();
    Profile = PGOOptions(ProfileUse, "", "", "", PGOOptions::IRUse);
  }
  bool Annotating = Profile && Profile->Action == PGOOptions::IRUse;
  ProfileMatch Match;
  if (Annotating)
    M.getContext().setDiagnosticHandler(
        std::make_unique<ProfileMatchHandler>(Match));
  {
    Pipeline P(Machine, Level, std::move(Profile));
    if (Annotating)
      P.countAnnotated(Match.Annotated);
    P.PB.buildPerModuleDefaultPipeline(Level).run(M, P.MAM);
  }
  Result.Annotated = Match.Annotated.load();
  Result.Mismatched = Match.Mismatched.load();
  Result.Missing = Match.Missing.load();
  if (std::optional<EmitFailure> Failure =
          verify(M, "post_optimization_verification_failed"))
    return Failure->Message;
  return std::nullopt;
}

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
      (Options.FileType != "obj" || Options.OptLevel == "s" ||
       Options.OptLevel == "z"))
    return reportError("invalid_partitions",
                       "several outputs require object emission at opt-level "
                       "0, 1, 2, or 3",
                       Options.DiagnosticFormat);
  if (!Options.CacheDirectory.empty() && Options.Outputs.size() == 1)
    return reportError("invalid_cache_directory",
                       "a cache directory requires several outputs",
                       Options.DiagnosticFormat);
  if (Options.RelocationModel != "pic")
    return reportError("invalid_relocation_model",
                       "only the pic relocation model is supported",
                       Options.DiagnosticFormat);
  if (!Options.ImportBitcode.empty() && Options.OptLevel == "0")
    return reportError("invalid_import",
                       "runtime bitcode import requires an optimized build",
                       Options.DiagnosticFormat);
  if (!Options.ProfileUse.empty())
    reportMissingProfiles();
  if (std::optional<EmitFailure> Failure = inspectProfile(Options))
    return reportError(Failure->Code, Failure->Message,
                       Options.DiagnosticFormat);
  if (Options.SplitCodegen && (Options.Outputs.size() < 2 ||
                               Options.OptLevel == "0" ||
                               !Options.CacheDirectory.empty()))
    return reportError("invalid_split",
                       "--split codegen requires several outputs, an "
                       "optimized build, and no cache directory",
                       Options.DiagnosticFormat);
  if (Options.Outputs.size() > 1 && !Options.SplitCodegen)
    return emitPartitions(Options);

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
  if (Options.SplitCodegen) {
    ProfileMatch Match;
    if (std::optional<EmitFailure> Failure =
            emitSplitCodegen(Options, *Mod, *Machine, Level, Match))
      return reportError(Failure->Code, Failure->Message,
                         Options.DiagnosticFormat);
    if (!Options.ProfileUse.empty())
      reportProfileMatch(Match);
    return 0;
  }
  std::vector<SmallString<256>> Temporaries;
  ProfileMatch Match;
  std::optional<EmitFailure> Failure =
      emitModule(*Mod, *Machine, Level, profileOptions(Options), Type,
                 Options.Outputs[0], Temporaries, Match);
  if (!Failure)
    Failure = publish(Temporaries[0], Options.Outputs[0]);
  if (Failure) {
    for (const SmallString<256> &Temporary : Temporaries)
      sys::fs::remove(Temporary);
    return reportError(Failure->Code, Failure->Message,
                       Options.DiagnosticFormat);
  }
  if (!Options.ProfileUse.empty())
    reportProfileMatch(Match);
  return 0;
}

} // namespace scriptc
