#include "runtime-import.h"

#include "llvm/ADT/DenseMap.h"
#include "llvm/ADT/DenseSet.h"
#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/ADT/Twine.h"
#include "llvm/Bitcode/BitcodeReader.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/GlobalAlias.h"
#include "llvm/IR/GlobalVariable.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Module.h"
#include "llvm/Linker/Linker.h"
#include "llvm/Support/Error.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/raw_ostream.h"

#include <cstdlib>
#include <memory>
#include <vector>

using namespace llvm;

namespace scriptc {

namespace {

// Upper bound on the instruction count of an imported function. The
// inliner never takes bodies much larger than this at O2, and bounding the
// import keeps the extra optimization work proportional to what can pay off.
//
// Like ThinLTO's function import, the limit applies to functions the program
// references directly and decays with every call-graph hop below them. Deep
// slow paths (cycle collection, destruction queues, allocation growth) then
// stay out of line instead of being folded bottom-up into small entry points
// until those entry points are too large to inline at program call sites.
constexpr unsigned MaxInstructions = 100;
constexpr unsigned DecayPercent = 30;

struct References {
  // Every global referenced by the body, including through constant
  // expressions.
  SmallPtrSet<const GlobalValue *, 16> Globals;
  // Local functions referenced other than as the callee of a direct call.
  // Copying such a function would give it a second address.
  bool LocalFunctionAddressTaken = false;
  // First symbol that prevents import, for diagnostics.
  std::string Blocker;
};

void collectConstant(const Constant *C, SmallPtrSetImpl<const GlobalValue *> &Out,
                     SmallPtrSetImpl<const Constant *> &Seen) {
  if (const auto *GV = dyn_cast<GlobalValue>(C)) {
    Out.insert(GV);
    return;
  }
  if (!Seen.insert(C).second)
    return;
  for (const Use &Operand : C->operands())
    if (const auto *Inner = dyn_cast<Constant>(Operand.get()))
      collectConstant(Inner, Out, Seen);
}

bool candidate(const Function &F, unsigned Limit) {
  if (F.isDeclaration() || F.isVarArg() || F.hasFnAttribute(Attribute::NoInline) ||
      F.hasFnAttribute(Attribute::OptimizeNone) || F.hasFnAttribute(Attribute::Naked) ||
      F.hasPersonalityFn() || F.hasPrefixData() || F.hasPrologueData())
    return false;
  // Only strong external or local definitions. A weak or linkonce
  // definition may be replaced at link time, so its body is not the one
  // that will run.
  if (!F.hasExternalLinkage() && !F.hasLocalLinkage())
    return false;
  // The program calls the runtime ABI marker so that linking against a
  // mismatched runtime object fails; that reference must survive.
  if (F.getName().starts_with("scr_runtime_abi_"))
    return false;
  if (F.hasLocalLinkage() && F.hasAddressTaken())
    return false;
  unsigned Count = 0;
  for (const Instruction &I : instructions(F)) {
    if (++Count > Limit)
      return false;
    if (const auto *Call = dyn_cast<CallBase>(&I)) {
      if (Call->hasFnAttr(Attribute::ReturnsTwice))
        return false;
      if (const Function *Callee = Call->getCalledFunction())
        if (Callee->hasFnAttribute(Attribute::ReturnsTwice))
          return false;
    }
    for (const Use &Operand : I.operands())
      if (isa<BlockAddress>(Operand.get()))
        return false;
  }
  return true;
}

References referencesOf(const Function &F) {
  References Refs;
  SmallPtrSet<const Constant *, 32> Seen;
  for (const Instruction &I : instructions(F)) {
    const auto *Call = dyn_cast<CallBase>(&I);
    for (const Use &Operand : I.operands()) {
      const Value *V = Operand.get();
      if (const auto *Local = dyn_cast<Function>(V)) {
        Refs.Globals.insert(Local);
        if (Local->hasLocalLinkage() && !(Call && Call->isCallee(&Operand))) {
          Refs.LocalFunctionAddressTaken = true;
          if (Refs.Blocker.empty())
            Refs.Blocker = ("&" + Local->getName()).str();
        }
        continue;
      }
      if (const auto *C = dyn_cast<Constant>(V)) {
        SmallPtrSet<const GlobalValue *, 8> Inner;
        collectConstant(C, Inner, Seen);
        for (const GlobalValue *GV : Inner) {
          Refs.Globals.insert(GV);
          if (isa<Function>(GV) && GV->hasLocalLinkage()) {
            Refs.LocalFunctionAddressTaken = true;
            if (Refs.Blocker.empty())
              Refs.Blocker = ("&" + GV->getName()).str();
          }
        }
      }
    }
  }
  return Refs;
}

// A local constant may be copied when its address is insignificant and its
// initializer only names external symbols or other copyable constants.
bool copyableConstant(const GlobalVariable &V,
                      DenseMap<const GlobalVariable *, bool> &Memo) {
  auto Found = Memo.find(&V);
  if (Found != Memo.end())
    return Found->second;
  Memo[&V] = false;
  if (!V.isConstant() || V.isThreadLocal() || !V.hasAtLeastLocalUnnamedAddr() ||
      !V.hasInitializer())
    return false;
  SmallPtrSet<const GlobalValue *, 8> Inner;
  SmallPtrSet<const Constant *, 16> Seen;
  collectConstant(V.getInitializer(), Inner, Seen);
  for (const GlobalValue *GV : Inner) {
    if (!GV->hasLocalLinkage()) {
      if (isa<GlobalAlias>(GV) || isa<GlobalIFunc>(GV))
        return false;
      continue;
    }
    const auto *Nested = dyn_cast<GlobalVariable>(GV);
    if (Nested == nullptr || !copyableConstant(*Nested, Memo))
      return false;
  }
  Memo[&V] = true;
  return true;
}

void stripTargetSpecificAttributes(Function &F) {
  // The program module compiles for the helper's target machine; keep the
  // imported bodies on the same subtarget so they are inline-compatible,
  // and do not spread the runtime's stack protector into program frames.
  F.removeFnAttr("target-cpu");
  F.removeFnAttr("target-features");
  F.removeFnAttr("tune-cpu");
  F.removeFnAttr("stack-protector-buffer-size");
  // Apple clang requests __chkstk_darwin probes, which upstream LLVM does not
  // lower; program frames are not probed either.
  F.removeFnAttr("probe-stack");
  F.removeFnAttr("stack-probe-size");
  F.removeFnAttr(Attribute::StackProtect);
  F.removeFnAttr(Attribute::StackProtectStrong);
  F.removeFnAttr(Attribute::StackProtectReq);
}

// Rewrites a merged runtime module so that linking it with LinkOnlyNeeded
// imports only safe, available_externally definitions.
void prepareImport(Module &Runtime, const std::vector<std::string> &Roots) {
  unsigned Limit = MaxInstructions;
  std::vector<Function *> Candidates;
  DenseMap<const Function *, References> Refs;
  DenseSet<const Function *> Importable;
  DenseMap<const Function *, std::string> Blockers;
  for (Function &F : Runtime)
    if (candidate(F, Limit)) {
      References R = referencesOf(F);
      if (R.LocalFunctionAddressTaken) {
        Blockers[&F] = R.Blocker;
        continue;
      }
      Candidates.push_back(&F);
      Importable.insert(&F);
      Refs[&F] = std::move(R);
    }

  DenseMap<const GlobalVariable *, bool> ConstantMemo;
  auto Restrict = [&]() {
  bool Changed = true;
  while (Changed) {
    Changed = false;
    for (Function *F : Candidates) {
      if (!Importable.contains(F))
        continue;
      bool Ok = true;
      for (const GlobalValue *GV : Refs[F].Globals) {
        if (isa<GlobalAlias>(GV) || isa<GlobalIFunc>(GV)) {
          Ok = false;
          break;
        }
        if (!GV->hasLocalLinkage())
          continue;
        if (const auto *Callee = dyn_cast<Function>(GV)) {
          if (!Importable.contains(Callee)) {
            Ok = false;
            break;
          }
        } else if (!copyableConstant(*cast<GlobalVariable>(GV), ConstantMemo)) {
          Ok = false;
          break;
        }
      }
      if (!Ok) {
        if (Blockers.find(F) == Blockers.end()) {
          for (const GlobalValue *GV : Refs[F].Globals)
            if (GV->hasLocalLinkage() || isa<GlobalAlias>(GV)) {
              const auto *Callee = dyn_cast<Function>(GV);
              const auto *Var = dyn_cast<GlobalVariable>(GV);
              bool Blocks = Callee ? !Importable.contains(Callee)
                            : Var  ? !copyableConstant(*Var, ConstantMemo)
                                   : true;
              if (Blocks) {
                Blockers[F] = GV->getName().str();
                break;
              }
            }
        }
        Importable.erase(F);
        Changed = true;
      }
    }
  }
  };
  Restrict();

  // Select by call-graph distance from the program's references.
  {
    DenseSet<const Function *> Selected;
    DenseSet<const Function *> Queued;
    std::vector<std::pair<Function *, unsigned>> Queue;
    for (const std::string &Name : Roots)
      if (Function *F = Runtime.getFunction(Name))
        if (Importable.contains(F) && Queued.insert(F).second)
          Queue.push_back({F, 0});
    for (size_t Next = 0; Next < Queue.size(); ++Next) {
      auto [F, Depth] = Queue[Next];
      double Allowed = Limit;
      for (unsigned I = 0; I < Depth; ++I)
        Allowed = Allowed * DecayPercent / 100.0;
      if (F->getInstructionCount() > Allowed)
        continue;
      Selected.insert(F);
      for (const GlobalValue *GV : Refs[F].Globals)
        if (const auto *Callee = dyn_cast<Function>(GV)) {
          auto *Mutable = const_cast<Function *>(Callee);
          if (Importable.contains(Callee) && Queued.insert(Callee).second)
            Queue.push_back({Mutable, Depth + 1});
        }
    }
    Importable = std::move(Selected);
    Restrict();
  }

  if (std::getenv("SCRIPTC_RUNTIME_IMPORT_DEBUG") != nullptr) {
    for (Function &F : Runtime) {
      if (F.isDeclaration())
        continue;
      const char *State = Importable.contains(&F) ? "import"
                          : Refs.count(&F)       ? "reject-refs"
                                                 : "reject";
      auto Blocker = Blockers.find(&F);
      errs() << State << " " << F.getName() << " " << F.getInstructionCount()
             << " " << (Blocker == Blockers.end() ? "" : Blocker->second)
             << "\n";
    }
  }

  for (Function &F : Runtime) {
    if (F.isDeclaration())
      continue;
    if (Importable.contains(&F)) {
      stripTargetSpecificAttributes(F);
      if (!F.hasLocalLinkage()) {
        F.setLinkage(GlobalValue::AvailableExternallyLinkage);
        F.setComdat(nullptr);
      }
    } else if (!F.hasLocalLinkage()) {
      F.deleteBody();
      F.setComdat(nullptr);
    }
  }

  std::vector<GlobalVariable *> Appending;
  for (GlobalVariable &GV : Runtime.globals()) {
    if (GV.hasAppendingLinkage()) {
      Appending.push_back(&GV);
      continue;
    }
    if (!GV.isDeclaration() && !GV.hasLocalLinkage()) {
      GV.setInitializer(nullptr);
      GV.setLinkage(GlobalValue::ExternalLinkage);
      GV.setComdat(nullptr);
    }
  }
  for (GlobalVariable *GV : Appending)
    GV->eraseFromParent();

  std::vector<GlobalAlias *> Aliases;
  for (GlobalAlias &A : Runtime.aliases())
    Aliases.push_back(&A);
  for (GlobalAlias *A : Aliases) {
    if (A->hasLocalLinkage())
      continue;
    GlobalValue *Declaration;
    if (auto *Type = dyn_cast<FunctionType>(A->getValueType()))
      Declaration = Function::Create(Type, GlobalValue::ExternalLinkage,
                                     A->getAddressSpace(), "", &Runtime);
    else
      Declaration = new GlobalVariable(Runtime, A->getValueType(), false,
                                       GlobalValue::ExternalLinkage, nullptr, "");
    Declaration->takeName(A);
    A->replaceAllUsesWith(Declaration);
    A->eraseFromParent();
  }

  // Module-level assembly defines symbols in the runtime object (musl's
  // getcontext/setcontext); the linker would otherwise copy it verbatim into
  // the program and define those symbols twice.
  Runtime.setModuleInlineAsm("");

  // Module flags, identification, and autolink metadata describe the runtime
  // object, which is linked separately; none of it applies to program code.
  std::vector<NamedMDNode *> Named;
  for (NamedMDNode &Node : Runtime.named_metadata())
    Named.push_back(&Node);
  for (NamedMDNode *Node : Named)
    Runtime.eraseNamedMetadata(Node);
}

} // namespace

std::optional<std::string>
importRuntimeBitcode(Module &Program, const std::vector<std::string> &BitcodePaths) {
  if (BitcodePaths.empty())
    return std::nullopt;
  LLVMContext &Context = Program.getContext();
  std::unique_ptr<Module> Runtime;
  std::unique_ptr<Linker> Merger;
  for (const std::string &Path : BitcodePaths) {
    ErrorOr<std::unique_ptr<MemoryBuffer>> Buffer = MemoryBuffer::getFile(Path);
    if (!Buffer)
      return (Twine("could not read runtime bitcode ") + Path + ": " +
              Buffer.getError().message())
          .str();
    Expected<std::unique_ptr<Module>> Unit =
        parseBitcodeFile((*Buffer)->getMemBufferRef(), Context);
    if (!Unit)
      return (Twine("invalid runtime bitcode ") + Path + ": " +
              toString(Unit.takeError()))
          .str();
    if ((*Unit)->getDataLayout() != Program.getDataLayout())
      return (Twine("runtime bitcode ") + Path +
              " has a different data layout than the program")
          .str();
    (*Unit)->setTargetTriple(Program.getTargetTriple());
    if (!Runtime) {
      Runtime = std::move(*Unit);
      Merger = std::make_unique<Linker>(*Runtime);
    } else if (Merger->linkInModule(std::move(*Unit))) {
      return (Twine("could not merge runtime bitcode ") + Path).str();
    }
  }
  Merger.reset();
  std::vector<std::string> Roots;
  for (const Function &F : Program)
    if (F.isDeclaration() && !F.isIntrinsic())
      Roots.push_back(F.getName().str());
  prepareImport(*Runtime, Roots);
  if (Linker::linkModules(Program, std::move(Runtime), Linker::Flags::LinkOnlyNeeded))
    return std::string("could not link runtime bitcode into the program");
  return std::nullopt;
}

} // namespace scriptc
