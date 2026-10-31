#include "cpu-copies.h"

#include "llvm/ADT/STLExtras.h"
#include "llvm/ADT/SmallVector.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/ADT/StringMap.h"
#include "llvm/Analysis/LoopInfo.h"
#include "llvm/IR/DerivedTypes.h"
#include "llvm/IR/Dominators.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/GlobalVariable.h"
#include "llvm/IR/InstrTypes.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/IntrinsicInst.h"
#include "llvm/IR/Intrinsics.h"
#include "llvm/Transforms/Utils/Cloning.h"
#include "llvm/Transforms/Utils/ValueMapper.h"

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace llvm;

namespace scriptc {
namespace {

// A function's name without the `.llvm.<n>` suffix of the thin link.
StringRef stem(StringRef Name) {
  size_t At = Name.rfind(".llvm.");
  if (At == StringRef::npos)
    return Name;
  StringRef Suffix = Name.drop_front(At + 6);
  if (Suffix.empty() || !all_of(Suffix, isDigit))
    return Name;
  return Name.take_front(At);
}

// The size of a vector type in bits, or 0 for another type.
uint64_t vectorBits(Type *T) {
  auto *Vector = dyn_cast<FixedVectorType>(T);
  return Vector ? Vector->getPrimitiveSizeInBits().getFixedValue() : 0;
}

// Whether x86-64-v3 changes only the body's vector code of at most 128 bits:
// the body has such vectors, and nothing that the level compiles to faster
// code than the baseline, which is vectors of 256 bits (AVX2), and in a
// loop, rounding (SSE4.1; the baseline calls the C library) and bit counts
// (POPCNT, LZCNT, TZCNT). Scalar code keeps its x86-64-v3 code, whose VEX
// encodings need fewer register copies.
bool onlyNarrowVectors(Function &F) {
  DominatorTree Dominators(F);
  LoopInfo Loops(Dominators);
  bool Narrow = false;
  for (const BasicBlock &Block : F)
    for (const Instruction &I : Block) {
      uint64_t Bits = vectorBits(I.getType());
      for (const Use &Operand : I.operands())
        Bits = std::max(Bits, vectorBits(Operand->getType()));
      if (Bits > 128)
        return false;
      Narrow |= Bits != 0;
      const auto *Call = dyn_cast<IntrinsicInst>(&I);
      if (!Call || !Loops.getLoopFor(&Block))
        continue;
      switch (Call->getIntrinsicID()) {
      case Intrinsic::floor:
      case Intrinsic::ceil:
      case Intrinsic::trunc:
      case Intrinsic::rint:
      case Intrinsic::nearbyint:
      case Intrinsic::round:
      case Intrinsic::roundeven:
      case Intrinsic::ctpop:
      case Intrinsic::ctlz:
      case Intrinsic::cttz:
        return false;
      default:
        break;
      }
    }
  return Narrow;
}

// Replaces the body of Copy with a clone of Base's. The clone's direct calls
// to baseline copies call the matching x86-64-v3 copies in Tier.
void useBaselineBody(Function &Copy, Function &Base,
                     const StringMap<Function *> &Tier) {
  GlobalValue::LinkageTypes Linkage = Copy.getLinkage();
  GlobalValue::VisibilityTypes Visibility = Copy.getVisibility();
  GlobalValue::UnnamedAddr UnnamedAddr = Copy.getUnnamedAddr();
  Copy.deleteBody();
  ValueToValueMapTy Map;
  for (auto [From, To] : zip(Base.args(), Copy.args()))
    Map[&From] = &To;
  SmallVector<ReturnInst *, 4> Returns;
  CloneFunctionInto(&Copy, &Base, Map,
                    CloneFunctionChangeType::LocalChangesOnly, Returns);
  Copy.setLinkage(Linkage);
  Copy.setVisibility(Visibility);
  Copy.setUnnamedAddr(UnnamedAddr);
  for (BasicBlock &Block : Copy)
    for (Instruction &I : Block) {
      auto *Call = dyn_cast<CallBase>(&I);
      Function *Callee = Call ? Call->getCalledFunction() : nullptr;
      if (!Callee)
        continue;
      StringRef Name = stem(Callee->getName());
      if (!Name.consume_back(".base"))
        continue;
      auto It = Tier.find((Name + ".v3").str());
      if (It != Tier.end() &&
          It->second->getFunctionType() == Callee->getFunctionType())
        Call->setCalledFunction(It->second);
    }
}

// Whether the module counts executions for a profile (`--profile-generate`,
// also after inlining in a context-sensitive second phase): its functions
// increment counters named after themselves (`__profc_<name>`).
bool countsExecutions(const Module &M) {
  for (const GlobalVariable &Global : M.globals())
    if (Global.getName().starts_with("__profc_"))
      return true;
  for (const Function &F : M)
    if (F.isIntrinsic() && F.getName().starts_with("llvm.instrprof."))
      return true;
  return false;
}

// Whether Base's body was optimized for fewer runs than Copy's: a profile
// collected where the executable ran its x86-64-v3 copies gives their
// baseline copies no runs, and the optimizer treats those as cold code.
bool ranLess(const Function &Base, const Function &Copy) {
  std::optional<Function::ProfileCount> Runs = Copy.getEntryCount();
  if (!Runs)
    return false;
  std::optional<Function::ProfileCount> BaseRuns = Base.getEntryCount();
  return !BaseRuns || BaseRuns->getCount() < Runs->getCount();
}

} // namespace

void useBaselineBodies(Module &M) {
  // Every function by its stem, so the copies of one function find each
  // other whichever of them the thin link renamed.
  StringMap<Function *> Functions;
  bool HasCopies = false;
  for (Function &F : M) {
    Functions[stem(F.getName())] = &F;
    HasCopies |= F.hasFnAttribute(CpuCopyAttribute);
  }
  // A copy that took its baseline copy's body would count its executions
  // against the baseline copy, and a build with the profile would then
  // optimize the x86-64-v3 copy as if it never ran.
  if (!HasCopies || countsExecutions(M))
    return;
  std::vector<std::pair<Function *, Function *>> Replaced;
  for (Function &F : M) {
    if (F.isDeclaration() || !F.hasFnAttribute(CpuCopyAttribute))
      continue;
    StringRef Name = stem(F.getName());
    if (!Name.consume_back(".v3"))
      continue;
    auto It = Functions.find((Name + ".base").str());
    if (It == Functions.end())
      continue;
    Function *Base = It->second;
    if (Base->isDeclaration() || Base->hasAvailableExternallyLinkage() ||
        Base->getFunctionType() != F.getFunctionType() ||
        ranLess(*Base, F) || !onlyNarrowVectors(F))
      continue;
    Replaced.emplace_back(&F, Base);
  }
  for (auto [Copy, Base] : Replaced)
    useBaselineBody(*Copy, *Base, Functions);
}

} // namespace scriptc
