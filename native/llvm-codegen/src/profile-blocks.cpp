#include "profile-blocks.h"

#include "llvm/ADT/DenseMap.h"
#include "llvm/ADT/DepthFirstIterator.h"
#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/ADT/SmallString.h"
#include "llvm/ADT/SmallVector.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/Analysis/BlockFrequencyInfo.h"
#include "llvm/Analysis/BranchProbabilityInfo.h"
#include "llvm/Analysis/LoopInfo.h"
#include "llvm/Analysis/ProfileSummaryInfo.h"
#include "llvm/IR/CFG.h"
#include "llvm/IR/Dominators.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/ProfDataUtils.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Instrumentation/PGOInstrumentation.h"
#include "llvm/Transforms/Utils/SampleProfileInference.h"

#include <algorithm>

using namespace llvm;

namespace scriptc {

namespace {

constexpr StringRef Header = "scriptc-profile-blocks 1";

// An edge whose branch weight is below this fraction of its branch's total
// counts as unlikely in flow inference.
constexpr uint64_t UnlikelyRatio = 1000;

// Alignments of more blocks than this product fall back to matching labels
// that occur once on each side.
constexpr uint64_t MaxAlignmentCells = uint64_t(1) << 22;

void writeEscaped(raw_ostream &OS, StringRef Text) {
  if (Text.empty()) {
    OS << '\\';
    return;
  }
  for (unsigned char C : Text) {
    if (C <= ' ' || C >= 0x7f || C == '\\')
      OS << '\\' << hexdigit(C >> 4, /*LowerCase=*/true)
         << hexdigit(C & 15, /*LowerCase=*/true);
    else
      OS << C;
  }
}

bool readEscaped(StringRef Token, std::string &Out) {
  Out.clear();
  if (Token == "\\")
    return true;
  for (size_t I = 0; I < Token.size(); ++I) {
    if (Token[I] != '\\') {
      Out.push_back(Token[I]);
      continue;
    }
    if (I + 2 >= Token.size())
      return false;
    unsigned High = hexDigitValue(Token[I + 1]);
    unsigned Low = hexDigitValue(Token[I + 2]);
    if (High > 15 || Low > 15)
      return false;
    Out.push_back(static_cast<char>(High << 4 | Low));
    I += 2;
  }
  return true;
}

// A block label's kind: the label without its digits. The emitter numbers
// each function's blocks in order (`if.t3`, `loop.c4`), so a block added or
// removed earlier in the function renumbers the blocks after it but keeps
// their kinds.
std::string kindOf(StringRef Label) {
  std::string Kind;
  Kind.reserve(Label.size());
  for (char C : Label)
    if (!isDigit(C))
      Kind.push_back(C);
  return Kind;
}

struct Token {
  std::string Kind;
  StringRef Label;
  size_t Successors;
};

bool sameKind(const Token &A, const Token &B) {
  return A.Successors == B.Successors && A.Kind == B.Kind;
}

// Pairs every block of Blocks with the recorded block that holds its place,
// or -1: the longest common subsequence of the two block orders by kind and
// successor count, which prefers pairs whose labels are equal. Common
// leading and trailing runs pair up first; a remaining middle too large to
// align pairs the labels that occur once on each side.
std::vector<int64_t> alignBlocks(const FunctionBlocks &Record,
                                 ArrayRef<const BasicBlock *> Blocks) {
  std::vector<Token> Old, New;
  Old.reserve(Record.Blocks.size());
  for (const BlockRecord &Block : Record.Blocks)
    Old.push_back({kindOf(Block.Label), Block.Label, Block.Successors.size()});
  New.reserve(Blocks.size());
  for (const BasicBlock *Block : Blocks) {
    SmallPtrSet<const BasicBlock *, 4> Distinct(succ_begin(Block),
                                                succ_end(Block));
    New.push_back(
        {kindOf(Block->getName()), Block->getName(), Distinct.size()});
  }
  std::vector<int64_t> Match(New.size(), -1);
  size_t Begin = 0;
  while (Begin < Old.size() && Begin < New.size() &&
         sameKind(Old[Begin], New[Begin])) {
    Match[Begin] = static_cast<int64_t>(Begin);
    ++Begin;
  }
  size_t OldEnd = Old.size(), NewEnd = New.size();
  while (OldEnd > Begin && NewEnd > Begin &&
         sameKind(Old[OldEnd - 1], New[NewEnd - 1])) {
    --OldEnd;
    --NewEnd;
    Match[NewEnd] = static_cast<int64_t>(OldEnd);
  }
  size_t Rows = OldEnd - Begin, Columns = NewEnd - Begin;
  if (Rows == 0 || Columns == 0)
    return Match;
  auto Score = [&](size_t I, size_t J) -> uint32_t {
    const Token &A = Old[Begin + I], &B = New[Begin + J];
    if (!sameKind(A, B))
      return 0;
    return A.Label == B.Label ? 2 : 1;
  };
  if (uint64_t(Rows) * Columns <= MaxAlignmentCells) {
    // Best[I][J]: the best score of the middle's suffixes from I and J.
    size_t Width = Columns + 1;
    std::vector<uint32_t> Best((Rows + 1) * Width, 0);
    for (size_t I = Rows; I-- > 0;)
      for (size_t J = Columns; J-- > 0;) {
        uint32_t Value =
            std::max(Best[(I + 1) * Width + J], Best[I * Width + J + 1]);
        if (uint32_t S = Score(I, J))
          Value = std::max(Value, S + Best[(I + 1) * Width + J + 1]);
        Best[I * Width + J] = Value;
      }
    size_t I = 0, J = 0;
    while (I < Rows && J < Columns) {
      uint32_t S = Score(I, J);
      if (S && Best[I * Width + J] == S + Best[(I + 1) * Width + J + 1]) {
        Match[Begin + J] = static_cast<int64_t>(Begin + I);
        ++I;
        ++J;
      } else if (Best[I * Width + J] == Best[(I + 1) * Width + J]) {
        ++I;
      } else {
        ++J;
      }
    }
    return Match;
  }
  StringMap<int64_t> OldLabels, NewLabels;
  for (size_t I = Begin; I < OldEnd; ++I) {
    auto [It, Inserted] = OldLabels.try_emplace(Old[I].Label, I);
    if (!Inserted)
      It->second = -1;
  }
  for (size_t J = Begin; J < NewEnd; ++J) {
    auto [It, Inserted] = NewLabels.try_emplace(New[J].Label, J);
    if (!Inserted)
      It->second = -1;
  }
  for (const auto &Entry : NewLabels) {
    auto It = OldLabels.find(Entry.getKey());
    if (Entry.second < 0 || It == OldLabels.end() || It->second < 0 ||
        !sameKind(Old[It->second], New[Entry.second]))
      continue;
    Match[Entry.second] = It->second;
  }
  return Match;
}

// LLVM's profile inference costs, with recorded edge counts that cost as much
// to change as recorded block counts. Its default leaves edges free to
// change, and its rebalancing of the flow below a counted block spreads it
// evenly over the block's edges whatever their counts.
ProfiParams inferenceParams() {
  ProfiParams Params;
  Params.EvenFlowDistribution = true;
  Params.RebalanceUnknown = false;
  Params.JoinIslands = true;
  Params.CostBlockInc = 10;
  Params.CostBlockDec = 20;
  Params.CostBlockEntryInc = 40;
  Params.CostBlockEntryDec = 10;
  Params.CostBlockZeroInc = 11;
  Params.CostBlockUnknownInc = 0;
  Params.CostJumpInc = 10;
  Params.CostJumpFTInc = 10;
  Params.CostJumpDec = 20;
  Params.CostJumpFTDec = 20;
  Params.CostJumpUnknownInc = 0;
  Params.CostJumpUnknownFTInc = 0;
  return Params;
}

void markFrequency(Function &F, uint64_t EntryCount, uint64_t MaxCount,
                   const ProfileSummaryInfo &Summary) {
  if (Summary.isHotCount(EntryCount))
    F.addFnAttr(Attribute::InlineHint);
  else if (Summary.isColdCount(MaxCount) && !F.hasFnAttribute(Attribute::Hot))
    F.addFnAttr(Attribute::Cold);
}

} // namespace

std::unique_ptr<BlockCounts> readProfileBlocks(StringRef Path,
                                                 std::string &Error) {
  ErrorOr<std::unique_ptr<MemoryBuffer>> Buffer = MemoryBuffer::getFile(Path);
  if (!Buffer) {
    Error = Path.str() + ": " + Buffer.getError().message();
    return nullptr;
  }
  auto Blocks = std::make_unique<BlockCounts>();
  StringRef Rest = (*Buffer)->getBuffer();
  size_t Line = 0;
  auto Fail = [&](StringRef Why) {
    Error = (Path + ":" + Twine(Line) + ": " + Why).str();
    return nullptr;
  };
  auto NextLine = [&]() {
    auto [Current, Remaining] = Rest.split('\n');
    Rest = Remaining;
    ++Line;
    return Current;
  };
  if (NextLine() != Header)
    return Fail("not a scriptc profile blocks file");
  SmallVector<StringRef, 16> Fields;
  std::string Name, Label;
  while (!Rest.empty()) {
    Fields.clear();
    NextLine().split(Fields, ' ', -1, /*KeepEmpty=*/false);
    uint64_t Entry = 0, Count = 0;
    if (Fields.size() != 4 || Fields[0] != "f" ||
        !readEscaped(Fields[1], Name) || Fields[2].getAsInteger(10, Entry) ||
        Fields[3].getAsInteger(10, Count))
      return Fail("expected a function line");
    FunctionBlocks &Function = (*Blocks)[Name];
    Function.EntryCount = Entry;
    Function.Blocks.resize(Count);
    for (BlockRecord &Block : Function.Blocks) {
      Fields.clear();
      if (Rest.empty())
        return Fail("expected a block line");
      NextLine().split(Fields, ' ', -1, /*KeepEmpty=*/false);
      if (Fields.size() < 2 || !readEscaped(Fields[0], Label) ||
          Fields[1].getAsInteger(10, Block.Count))
        return Fail("expected a block line");
      Block.Label = Label;
      for (StringRef Field : ArrayRef(Fields).drop_front(2)) {
        auto [Position, EdgeCount] = Field.split(':');
        uint32_t Successor = 0;
        uint64_t Value = 0;
        if (Position.getAsInteger(10, Successor) ||
            EdgeCount.getAsInteger(10, Value) || Successor >= Count)
          return Fail("expected a successor and its edge count");
        Block.Successors.push_back({Successor, Value});
      }
    }
  }
  return Blocks;
}

void annotateFromBlocks(Function &F, const FunctionBlocks &Record,
                        const ProfileSummaryInfo &Summary) {
  if (Record.EntryCount == 0 || Record.Blocks.empty()) {
    F.setEntryCount(Function::ProfileCount(0, Function::PCT_Real));
    if (Summary.hasProfileSummary() && !F.hasFnAttribute(Attribute::Hot))
      F.addFnAttr(Attribute::Cold);
    return;
  }
  std::vector<const BasicBlock *> Order;
  for (const BasicBlock &Block : F)
    Order.push_back(&Block);
  std::vector<int64_t> Match = alignBlocks(Record, Order);
  std::vector<bool> Paired(Record.Blocks.size(), false);
  for (int64_t Recorded : Match)
    if (Recorded >= 0)
      Paired[Recorded] = true;

  // Flow runs through the blocks that the entry reaches and that reach an
  // exit, in the function's order, as LLVM's profile inference requires.
  df_iterator_default_set<const BasicBlock *> Forward, Backward;
  for (const BasicBlock *Block : depth_first_ext(&F, Forward))
    (void)Block;
  for (const BasicBlock &Block : F)
    if (succ_empty(&Block))
      for (const BasicBlock *Reaching :
           inverse_depth_first_ext(&Block, Backward))
        (void)Reaching;
  DenseMap<const BasicBlock *, size_t> Position, Node;
  FlowFunction Flow;
  for (size_t I = 0; I < Order.size(); ++I) {
    Position[Order[I]] = I;
    if (!Forward.contains(Order[I]) || !Backward.contains(Order[I]))
      continue;
    Node[Order[I]] = Flow.Blocks.size();
    FlowBlock Block;
    Block.Index = Flow.Blocks.size();
    if (Match[I] >= 0) {
      Block.Weight = Record.Blocks[Match[I]].Count;
      Block.HasUnknownWeight = false;
    } else if (I == 0) {
      Block.Weight = Record.EntryCount;
      Block.HasUnknownWeight = false;
    }
    Flow.Blocks.push_back(Block);
  }
  uint64_t EntryCount = Record.EntryCount, MaxCount = Record.EntryCount;
  if (Flow.Blocks.size() > 1 && Node.count(&F.getEntryBlock())) {
    for (const BasicBlock *Block : Order) {
      auto Source = Node.find(Block);
      if (Source == Node.end())
        continue;
      int64_t From = Match[Position[Block]];
      SmallVector<const BasicBlock *, 4> Targets, Successors;
      for (const BasicBlock *Successor : successors(Block)) {
        Successors.push_back(Successor);
        if (!is_contained(Targets, Successor))
          Targets.push_back(Successor);
      }
      SmallVector<uint32_t, 4> Weights;
      extractBranchWeights(*Block->getTerminator(), Weights);
      const BlockRecord *Recorded = From >= 0 ? &Record.Blocks[From] : nullptr;
      for (size_t K = 0; K < Targets.size(); ++K) {
        auto Target = Node.find(Targets[K]);
        if (Target == Node.end())
          continue;
        FlowJump Jump;
        Jump.Source = Source->second;
        Jump.Target = Target->second;
        if (Recorded != nullptr) {
          // An edge to the recorded target's pair takes that edge's count.
          // An edge to an unpaired target takes the count of the recorded
          // edge in its place among the block's targets, which a paired
          // block has as many of, when that edge's target is unpaired too:
          // a target whose label changed keeps its edge's count.
          int64_t To = Match[Position[Targets[K]]];
          auto Edge = llvm::find_if(Recorded->Successors, [&](const auto &E) {
            return To >= 0 && E.first == static_cast<uint64_t>(To);
          });
          if (Edge == Recorded->Successors.end() && To < 0 &&
              Recorded->Successors.size() == Targets.size() &&
              !Paired[Recorded->Successors[K].first])
            Edge = Recorded->Successors.begin() + K;
          if (Edge != Recorded->Successors.end()) {
            Jump.Weight = Edge->second;
            Jump.HasUnknownWeight = false;
          }
        }
        // An edge without a recorded count that the function's own branch
        // weights (from llvm.expect) make unlikely takes flow only when no
        // other path can.
        if (Jump.HasUnknownWeight && Weights.size() == Successors.size()) {
          uint64_t Total = 0, Weight = 0;
          for (size_t I = 0; I < Successors.size(); ++I) {
            Total += Weights[I];
            if (Successors[I] == Targets[K])
              Weight += Weights[I];
          }
          Jump.IsUnlikely = Weight * UnlikelyRatio < Total;
        }
        Flow.Jumps.push_back(Jump);
      }
    }
    for (FlowJump &Jump : Flow.Jumps) {
      Flow.Blocks[Jump.Source].SuccJumps.push_back(&Jump);
      Flow.Blocks[Jump.Target].PredJumps.push_back(&Jump);
    }
    applyFlowInference(inferenceParams(), Flow);
    EntryCount = Flow.Blocks[0].Flow;
    MaxCount = 0;
    for (const FlowBlock &Block : Flow.Blocks)
      MaxCount = std::max(MaxCount, Block.Flow);
    if (MaxCount > 0 && EntryCount == 0)
      EntryCount = 1;
    // Branch weights as the profile annotation sets them: the first
    // successor position of each target takes the edge's count.
    DenseMap<std::pair<size_t, size_t>, uint64_t> JumpFlow;
    for (const FlowJump &Jump : Flow.Jumps)
      JumpFlow[{Jump.Source, Jump.Target}] = Jump.Flow;
    for (BasicBlock &Block : F) {
      auto Source = Node.find(&Block);
      Instruction *Terminator = Block.getTerminator();
      if (Source == Node.end() || Flow.Blocks[Source->second].Flow == 0 ||
          Terminator->getNumSuccessors() < 2 ||
          !(isa<BranchInst>(Terminator) || isa<SwitchInst>(Terminator) ||
            isa<IndirectBrInst>(Terminator) || isa<InvokeInst>(Terminator) ||
            isa<CallBrInst>(Terminator)))
        continue;
      SmallVector<uint64_t, 4> Counts(Terminator->getNumSuccessors(), 0);
      SmallPtrSet<const BasicBlock *, 4> Seen;
      uint64_t Max = 0;
      for (unsigned I = 0; I < Terminator->getNumSuccessors(); ++I) {
        const BasicBlock *Successor = Terminator->getSuccessor(I);
        auto Target = Node.find(Successor);
        if (Target == Node.end() || !Seen.insert(Successor).second)
          continue;
        Counts[I] = JumpFlow.lookup({Source->second, Target->second});
        Max = std::max(Max, Counts[I]);
      }
      if (Max > 0)
        setProfMetadata(Terminator, Counts, Max);
    }
  }
  F.setEntryCount(Function::ProfileCount(EntryCount, Function::PCT_Real));
  markFrequency(F, EntryCount, MaxCount, Summary);
}

void BlockRecorder::addNeverRan(const Function &F) {
  std::string Text;
  raw_string_ostream OS(Text);
  OS << "f ";
  writeEscaped(OS, F.getName());
  OS << " 0 0\n";
  std::lock_guard<std::mutex> Guard(Lock);
  Records.emplace(F.getName().str(), std::move(Text));
}

void BlockRecorder::add(const Function &F) {
  std::optional<Function::ProfileCount> Entry = F.getEntryCount();
  if (!Entry || Entry->isSynthetic())
    return;
  std::string Text;
  raw_string_ostream OS(Text);
  OS << "f ";
  writeEscaped(OS, F.getName());
  if (Entry->getCount() == 0) {
    OS << " 0 0\n";
  } else {
    OS << ' ' << Entry->getCount() << ' ' << F.size() << '\n';
    Function &Mutable = const_cast<Function &>(F);
    DominatorTree Dominators(Mutable);
    LoopInfo Loops(Dominators);
    BranchProbabilityInfo Probabilities(F, Loops);
    BlockFrequencyInfo Frequencies(F, Probabilities, Loops);
    DenseMap<const BasicBlock *, uint32_t> Position;
    uint32_t Next = 0;
    for (const BasicBlock &Block : F)
      Position[&Block] = Next++;
    for (const BasicBlock &Block : F) {
      uint64_t Count = Frequencies.getBlockProfileCount(&Block).value_or(0);
      writeEscaped(OS, Block.getName());
      OS << ' ' << Count;
      // Edges to one target through several successor positions add up.
      SmallVector<std::pair<uint32_t, uint64_t>, 4> Edges;
      const Instruction *Terminator = Block.getTerminator();
      for (unsigned I = 0, E = Terminator->getNumSuccessors(); I < E; ++I) {
        uint32_t Target = Position.lookup(Terminator->getSuccessor(I));
        uint64_t EdgeCount =
            Probabilities.getEdgeProbability(&Block, I).scale(Count);
        auto It = llvm::find_if(Edges, [&](const auto &Edge) {
          return Edge.first == Target;
        });
        if (It == Edges.end())
          Edges.push_back({Target, EdgeCount});
        else
          It->second += EdgeCount;
      }
      for (auto [Target, EdgeCount] : Edges)
        OS << ' ' << Target << ':' << EdgeCount;
      OS << '\n';
    }
  }
  std::lock_guard<std::mutex> Guard(Lock);
  Records[F.getName().str()] = std::move(Text);
}

std::optional<std::string> BlockRecorder::write(StringRef Path) {
  SmallString<256> Temporary(Path);
  Temporary += ".tmp-%%%%%%";
  int Fd = -1;
  if (std::error_code EC = sys::fs::createUniqueFile(Temporary, Fd, Temporary))
    return EC.message();
  {
    raw_fd_ostream Stream(Fd, /*shouldClose=*/true);
    Stream << Header << '\n';
    std::lock_guard<std::mutex> Guard(Lock);
    for (const auto &[Name, Text] : Records)
      Stream << Text;
    Stream.close();
    if (Stream.has_error()) {
      std::string Message = Stream.error().message();
      Stream.clear_error();
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

} // namespace scriptc
