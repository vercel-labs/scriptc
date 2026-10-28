#include "rc-pairs.h"

#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/ADT/SmallVector.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/IntrinsicInst.h"
#include "llvm/IR/IRBuilder.h"
#include "llvm/IR/Module.h"
#include "llvm/Transforms/Utils/ModuleUtils.h"
#include <cstdlib>
#include "llvm/Support/raw_ostream.h"

using namespace llvm;

namespace scriptc {

namespace {

// The emitter's retain helpers return their argument; the release helpers
// take one pointer. Slow paths, teardowns and segment frees are not pairs.
bool isRetain(const Function *F) {
  if (!F)
    return false;
  StringRef N = F->getName();
  return N.starts_with("sc_rc_retain_") || N.starts_with("sc_rretain_") ||
         N.starts_with("sc_tretain.");
}

bool isRelease(const Function *F) {
  if (!F)
    return false;
  StringRef N = F->getName();
  if (N.contains("_destroy") || N.contains("_slow") || N.contains("_seg"))
    return false;
  return N.starts_with("sc_rc_release_") || N.starts_with("sc_rrelease_") ||
         N.starts_with("sc_trelease.");
}

const Function *callee(const Instruction *I) {
  if (const auto *CB = dyn_cast<CallBase>(I))
    return CB->getCalledFunction();
  return nullptr;
}

bool isReleaseOf(const Instruction *I, const Value *V) {
  const auto *CB = dyn_cast<CallBase>(I);
  return CB && isRelease(CB->getCalledFunction()) && CB->arg_size() == 1 &&
         CB->getArgOperand(0) == V;
}

// A stack slot only this function's own loads and stores reach.
bool privateSlot(const AllocaInst *Slot) {
  for (const User *U : Slot->users()) {
    if (const auto *L = dyn_cast<LoadInst>(U)) {
      if (L->getPointerOperand() != Slot)
        return false;
    } else if (const auto *S = dyn_cast<StoreInst>(U)) {
      if (S->getPointerOperand() != Slot)
        return false;
    } else if (const auto *II = dyn_cast<IntrinsicInst>(U)) {
      if (!II->isLifetimeStartOrEnd())
        return false;
    } else {
      return false;
    }
  }
  return true;
}

// The retained copy's other uses only borrow it: call arguments, field
// addresses, loads through it, comparisons.
bool borrowedUses(const Instruction *Retain, SmallVectorImpl<Instruction *> &Releases) {
  for (const User *U : Retain->users()) {
    const auto *I = cast<Instruction>(U);
    if (isReleaseOf(I, Retain)) {
      Releases.push_back(const_cast<Instruction *>(I));
      continue;
    }
    if (const auto *CB = dyn_cast<CallBase>(I)) {
      if (CB->isCallee(&Retain->getOperandUse(0)) || isRetain(CB->getCalledFunction()))
        return false;
      continue;
    }
    if (isa<GetElementPtrInst>(I) || isa<ICmpInst>(I) || isa<PtrToIntInst>(I))
      continue;
    if (const auto *L = dyn_cast<LoadInst>(I))
      if (L->getPointerOperand() == Retain)
        continue;
    return false;
  }
  return !Releases.empty();
}

// Walks every path from just after `Retain` until a paired release. Fails on
// a path that returns or loops back to the retain without one, and on any
// instruction `Blocks` rejects.
template <typename Check>
bool everyPathReleases(Instruction *Retain, const SmallPtrSetImpl<Instruction *> &Releases,
                       Check Blocks) {
  SmallVector<std::pair<BasicBlock *, BasicBlock::iterator>, 16> Work;
  SmallPtrSet<BasicBlock *, 32> Seen;
  Work.push_back({Retain->getParent(), std::next(Retain->getIterator())});
  unsigned Budget = 4000;
  while (!Work.empty()) {
    auto [BB, It] = Work.pop_back_val();
    bool Released = false;
    for (; It != BB->end(); ++It) {
      Instruction *I = &*It;
      if (!Budget--)
        return false;
      if (Releases.count(I)) {
        Released = true;
        break;
      }
      if (I == Retain)
        return false;
      if (!Blocks(I))
        return false;
      if (isa<ReturnInst>(I))
        return false;
    }
    if (Released)
      continue;
    for (BasicBlock *Next : successors(BB)) {
      if (Next == Retain->getParent())
        return false;
      if (Seen.insert(Next).second)
        Work.push_back({Next, Next->begin()});
    }
  }
  return true;
}

bool removePair(CallInst *Retain) {
  Value *V = Retain->getArgOperand(0);
  SmallVector<Instruction *, 4> ReleaseList;
  if (!borrowedUses(Retain, ReleaseList))
    return false;
  SmallPtrSet<Instruction *, 4> Releases(ReleaseList.begin(), ReleaseList.end());

  const AllocaInst *Slot = nullptr;
  if (const auto *L = dyn_cast<LoadInst>(V))
    if (const auto *A = dyn_cast<AllocaInst>(L->getPointerOperand()))
      if (privateSlot(A))
        Slot = A;

  // The slot must still hold the loaded value at the retain.
  if (Slot) {
    const auto *L = cast<LoadInst>(V);
    if (L->getParent() != Retain->getParent())
      Slot = nullptr;
    else
      for (auto It = std::next(L->getIterator()); &*It != Retain; ++It) {
        if (const auto *S = dyn_cast<StoreInst>(&*It))
          if (S->getPointerOperand() == Slot) {
            Slot = nullptr;
            break;
          }
        if (const auto *CB = dyn_cast<CallBase>(&*It))
          if (isRelease(CB->getCalledFunction())) {
            Slot = nullptr;
            break;
          }
      }
  }

  bool Ok;
  if (Slot) {
    // The slot keeps its reference until this function stores into it or
    // releases what it holds; nothing else can reach it.
    Ok = everyPathReleases(Retain, Releases, [&](Instruction *I) {
      if (const auto *S = dyn_cast<StoreInst>(I))
        return S->getPointerOperand() != Slot;
      if (const auto *CB = dyn_cast<CallBase>(I)) {
        if (isRelease(CB->getCalledFunction()) && CB->arg_size() == 1) {
          const Value *A = CB->getArgOperand(0);
          if (A == V)
            return false;
          if (const auto *L = dyn_cast<LoadInst>(A))
            if (L->getPointerOperand() == Slot)
              return false;
        }
      }
      return true;
    });
  } else {
    // Nothing in between can release anything.
    Ok = everyPathReleases(Retain, Releases, [&](Instruction *I) {
      if (const auto *CB = dyn_cast<CallBase>(I)) {
        const Function *F = CB->getCalledFunction();
        if (isa<IntrinsicInst>(CB) || isRetain(F))
          return true;
        return false;
      }
      return true;
    });
  }
  if (!Ok)
    return false;
  for (Instruction *R : ReleaseList)
    R->eraseFromParent();
  Retain->replaceAllUsesWith(V);
  Retain->eraseFromParent();
  return true;
}

// Whether the value `V` a retain copied stays alive from `Retain` until
// every path reaches one of `Ends`: it was loaded from a private slot that
// nothing stores into or releases meanwhile, or nothing in between can
// release anything.
bool aliveUntil(CallInst *Retain, const SmallPtrSetImpl<Instruction *> &Ends) {
  Value *V = Retain->getArgOperand(0);
  const AllocaInst *Slot = nullptr;
  if (const auto *L = dyn_cast<LoadInst>(V))
    if (const auto *A = dyn_cast<AllocaInst>(L->getPointerOperand()))
      if (privateSlot(A) && L->getParent() == Retain->getParent()) {
        Slot = A;
        for (auto It = std::next(L->getIterator()); &*It != Retain; ++It) {
          if (const auto *S = dyn_cast<StoreInst>(&*It))
            if (S->getPointerOperand() == Slot)
              Slot = nullptr;
          if (const auto *CB = dyn_cast<CallBase>(&*It))
            if (isRelease(CB->getCalledFunction()))
              Slot = nullptr;
          if (!Slot)
            break;
        }
      }
  if (Slot)
    return everyPathReleases(Retain, Ends, [&](Instruction *I) {
      if (const auto *S = dyn_cast<StoreInst>(I))
        return S->getPointerOperand() != Slot;
      if (const auto *CB = dyn_cast<CallBase>(I))
        if (isRelease(CB->getCalledFunction()) && CB->arg_size() == 1) {
          const Value *A = CB->getArgOperand(0);
          if (A == V)
            return false;
          if (const auto *L = dyn_cast<LoadInst>(A))
            if (L->getPointerOperand() == Slot)
              return false;
        }
      return true;
    });
  return everyPathReleases(Retain, Ends, [&](Instruction *I) {
    if (const auto *CB = dyn_cast<CallBase>(I))
      return isa<IntrinsicInst>(CB) || isRetain(CB->getCalledFunction());
    return true;
  });
}

// A private temporary that only ever holds retained copies (or null) and
// whose loads are only borrowed or released: the copies' owners keep the
// values alive instead, so the retains and the releases go.
static bool rcDebug(const Function *F) {
  const char *D = getenv("SCRIPTC_RC_DEBUG");
  return D && F->getName() == D;
}
#define REJECT(why)                                                                          \
  do {                                                                                       \
    if (rcDebug(Temp->getFunction()))                                                        \
      errs() << "temp " << Temp->getName() << ": " << why << "\n";                          \
    return false;                                                                            \
  } while (0)

bool removeTemporary(AllocaInst *Temp) {
  SmallVector<CallInst *, 4> Retains;
  SmallVector<Instruction *, 8> Releases;
  for (User *U : Temp->users()) {
    if (auto *S = dyn_cast<StoreInst>(U)) {
      Value *Stored = S->getValueOperand();
      if (isa<ConstantPointerNull>(Stored))
        continue;
      auto *CI = dyn_cast<CallInst>(Stored);
      if (!CI || !isRetain(CI->getCalledFunction()) || CI->arg_size() != 1 || !CI->hasOneUse())
        REJECT("store of a non-copy");
      Retains.push_back(CI);
      continue;
    }
    if (auto *L = dyn_cast<LoadInst>(U)) {
      for (User *LU : L->users()) {
        auto *I = cast<Instruction>(LU);
        if (isReleaseOf(I, L)) {
          Releases.push_back(I);
          continue;
        }
        if (const auto *CB = dyn_cast<CallBase>(I)) {
          if (CB->isCallee(&L->getOperandUse(0)) || isRetain(CB->getCalledFunction()) ||
              isRelease(CB->getCalledFunction()))
            REJECT("load retained or called");
          continue;
        }
        if (isa<GetElementPtrInst>(I) || isa<ICmpInst>(I) || isa<PtrToIntInst>(I))
          continue;
        if (const auto *LL = dyn_cast<LoadInst>(I))
          if (LL->getPointerOperand() == L)
            continue;
        REJECT("load use " << *I);
      }
      continue;
    }
    if (const auto *II = dyn_cast<IntrinsicInst>(U))
      if (II->isLifetimeStartOrEnd())
        continue;
    REJECT("other user");
  }
  if (Retains.empty() || Releases.empty())
    REJECT("no copies or no releases");
  SmallPtrSet<Instruction *, 8> Ends(Releases.begin(), Releases.end());
  for (CallInst *CI : Retains)
    if (!aliveUntil(CI, Ends))
      REJECT("copy not kept alive: " << *CI->getArgOperand(0));
  // No path may store a second copy before the first is released.
  for (CallInst *CI : Retains) {
    bool Clean = everyPathReleases(CI, Ends, [&](Instruction *I) {
      if (const auto *S = dyn_cast<StoreInst>(I))
        return S->getPointerOperand() != Temp || S->getValueOperand() == CI;
      return true;
    });
    if (!Clean)
      REJECT("second copy stored before release");
  }
  for (Instruction *R : Releases)
    R->eraseFromParent();
  for (CallInst *CI : Retains) {
    CI->replaceAllUsesWith(CI->getArgOperand(0));
    CI->eraseFromParent();
  }
  return true;
}

} // namespace

// Diagnostics (SCRIPTC_RC_SITES): counts each remaining retain or release
// call and prints "<site> <function> <helper> <count>" lines at exit.
void instrumentSites(Module &M) {
  LLVMContext &C = M.getContext();
  Type *I64 = Type::getInt64Ty(C);
  Type *Ptr = PointerType::getUnqual(C);
  std::vector<std::pair<std::string, CallInst *>> Sites;
  for (Function &F : M)
    for (BasicBlock &BB : F)
      for (Instruction &I : BB)
        if (auto *CI = dyn_cast<CallInst>(&I))
          if (isRetain(CI->getCalledFunction()) || isRelease(CI->getCalledFunction()))
            Sites.push_back({(F.getName() + " " + CI->getCalledFunction()->getName()).str(), CI});
  if (Sites.empty())
    return;
  auto *Arr = ArrayType::get(I64, Sites.size());
  auto *Counts = new GlobalVariable(M, Arr, false, GlobalValue::InternalLinkage,
                                    Constant::getNullValue(Arr), "__rc_site_counts");
  for (size_t K = 0; K < Sites.size(); ++K) {
    IRBuilder<> B(Sites[K].second);
    Value *Slot = B.CreateConstGEP2_64(Arr, Counts, 0, K);
    B.CreateAtomicRMW(AtomicRMWInst::Add, Slot, ConstantInt::get(I64, 1), MaybeAlign(8),
                      AtomicOrdering::Monotonic);
  }
  // A table of names, and a dump function registered with atexit.
  std::vector<Constant *> Names;
  for (auto &[Name, _] : Sites) {
    Constant *Str = ConstantDataArray::getString(C, Name);
    auto *G = new GlobalVariable(M, Str->getType(), true, GlobalValue::PrivateLinkage, Str);
    Names.push_back(G);
  }
  auto *NamesTy = ArrayType::get(Ptr, Names.size());
  auto *NamesG = new GlobalVariable(M, NamesTy, true, GlobalValue::PrivateLinkage,
                                    ConstantArray::get(NamesTy, Names));
  FunctionCallee Printf = M.getOrInsertFunction(
      "printf", FunctionType::get(Type::getInt32Ty(C), {Ptr}, true));
  FunctionCallee AtExit = M.getOrInsertFunction(
      "atexit", FunctionType::get(Type::getInt32Ty(C), {Ptr}, false));
  Function *Dump = Function::Create(FunctionType::get(Type::getVoidTy(C), false),
                                    GlobalValue::InternalLinkage, "__rc_site_dump", M);
  {
    BasicBlock *Entry = BasicBlock::Create(C, "entry", Dump);
    BasicBlock *Loop = BasicBlock::Create(C, "loop", Dump);
    BasicBlock *Done = BasicBlock::Create(C, "done", Dump);
    IRBuilder<> B(Entry);
    Constant *Fmt = B.CreateGlobalString("rcsite %llu %s %llu\n");
    B.CreateBr(Loop);
    B.SetInsertPoint(Loop);
    PHINode *I = B.CreatePHI(I64, 2);
    I->addIncoming(ConstantInt::get(I64, 0), Entry);
    Value *Count = B.CreateLoad(I64, B.CreateGEP(Arr, Counts, {ConstantInt::get(I64, 0), I}));
    Value *Name = B.CreateLoad(Ptr, B.CreateGEP(NamesTy, NamesG, {ConstantInt::get(I64, 0), I}));
    B.CreateCall(Printf, {Fmt, I, Name, Count});
    Value *Next = B.CreateAdd(I, ConstantInt::get(I64, 1));
    I->addIncoming(Next, Loop);
    B.CreateCondBr(B.CreateICmpEQ(Next, ConstantInt::get(I64, Sites.size())), Done, Loop);
    B.SetInsertPoint(Done);
    B.CreateRetVoid();
  }
  Function *Init = Function::Create(FunctionType::get(Type::getVoidTy(C), false),
                                    GlobalValue::InternalLinkage, "__rc_site_init", M);
  {
    IRBuilder<> B(BasicBlock::Create(C, "entry", Init));
    B.CreateCall(AtExit, {Dump});
    B.CreateRetVoid();
  }
  appendToGlobalCtors(M, Init, 65535);
}

unsigned removeRcPairs(Module &M) {
  unsigned Removed = 0;
  for (Function &F : M) {
    if (F.isDeclaration())
      continue;
    StringRef N = F.getName();
    if (isRetain(&F) || isRelease(&F) || N.starts_with("sc_rrelease_") ||
        N.starts_with("sc_trelease."))
      continue;
    // A coroutine's frame lives on the heap, out of the stack scan's reach.
    bool Coroutine = false;
    for (BasicBlock &BB : F)
      for (Instruction &I : BB)
        if (auto *II = dyn_cast<IntrinsicInst>(&I))
          if (II->getIntrinsicID() == Intrinsic::coro_id || II->getIntrinsicID() == Intrinsic::coro_begin)
            Coroutine = true;
    if (Coroutine)
      continue;
    SmallVector<CallInst *, 64> Retains;
    for (BasicBlock &BB : F)
      for (Instruction &I : BB)
        if (auto *CI = dyn_cast<CallInst>(&I))
          if (isRetain(CI->getCalledFunction()) && CI->arg_size() == 1 && !CI->use_empty())
            Retains.push_back(CI);
    for (CallInst *CI : Retains)
      if (removePair(CI))
        ++Removed;
    SmallVector<AllocaInst *, 32> Temps;
    for (Instruction &I : F.getEntryBlock())
      if (auto *A = dyn_cast<AllocaInst>(&I))
        if (A->getAllocatedType()->isPointerTy() && privateSlot(A))
          Temps.push_back(A);
    for (AllocaInst *A : Temps)
      if (removeTemporary(A))
        ++Removed;
  }
  if (getenv("SCRIPTC_RC_SITES"))
    instrumentSites(M);
  return Removed;
}

} // namespace scriptc
