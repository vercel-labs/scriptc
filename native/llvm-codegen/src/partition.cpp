#include "partition.h"

#include "llvm/ADT/DenseMap.h"
#include "llvm/ADT/DenseSet.h"
#include "llvm/ADT/STLExtras.h"
#include "llvm/ADT/SmallVector.h"
#include "llvm/ADT/StringMap.h"
#include "llvm/ADT/Twine.h"
#include "llvm/Support/ThreadPool.h"
#include "llvm/Support/Threading.h"

#include <algorithm>
#include <cstdint>
#include <string>

using namespace llvm;

namespace scriptc {

namespace {

constexpr unsigned NoPartition = ~0u;

enum class SymbolKind : uint8_t { Function, Variable, Declaration };

struct Symbol {
  SymbolKind Kind = SymbolKind::Declaration;
  bool Local = false;
  StringRef Name;
  // Definition header line, or the complete declaration line.
  StringRef Header;
  // Function lines after the header, through the closing brace.
  StringRef Body;
  // Declaration other partitions use for this definition.
  std::string Declaration;
  // Local definitions are rewritten with hidden visibility.
  std::string PromotedHeader;
  std::vector<unsigned> Refs;
  // The functions its body calls directly (sorted).
  std::vector<unsigned> Calls;
  // A variable defined with "constant", whose loads the optimizer can fold.
  bool Constant = false;
  // A function the emitter marks as the entry module's top-level code.
  bool Entry = false;
  std::vector<unsigned> Metadata;
  // The source-module group the emitter wrote before this definition, or
  // empty.
  StringRef Group;
  unsigned Partition = NoPartition;
};

struct MetadataNode {
  StringRef Line;
  std::vector<unsigned> Refs;
  std::vector<unsigned> Symbols;
};

bool isNameChar(char C) {
  return (C >= 'a' && C <= 'z') || (C >= 'A' && C <= 'Z') ||
         (C >= '0' && C <= '9') || C == '-' || C == '$' || C == '.' ||
         C == '_';
}

bool isDigit(char C) { return C >= '0' && C <= '9'; }

// Whether a definition header carries the "scriptc-fallback" attribute: a
// body the emitter moved out of the function it stands in for, such as the
// original body of a function versioned for int32 loop bounds
// (FALLBACK_PLACEMENT_ATTR in emit-function.ts).
bool isPlacedByName(StringRef Header) {
  SmallVector<StringRef, 16> Tokens;
  Header.split(Tokens, ' ', -1, /*KeepEmpty=*/false);
  return llvm::is_contained(Tokens, "\"scriptc-fallback\"");
}

// Length of the unquoted symbol name starting at Text[Start], or 0.
size_t nameLength(StringRef Text, size_t Start) {
  size_t End = Start;
  while (End < Text.size() && isNameChar(Text[End]))
    ++End;
  return End - Start;
}

uint32_t stableHash(StringRef Name) {
  uint32_t Hash = 0x811c9dc5u;
  for (char C : Name) {
    Hash ^= static_cast<unsigned char>(C);
    Hash *= 0x01000193u;
  }
  return Hash;
}

constexpr unsigned MinGroupedPartitions = 32;

// Places the functions whose root carries a source-module group by group: a
// module's functions call each other most, so keeping them together leaves
// fewer calls for the thin link to import across partitions. A group larger
// than the mean partition, or than MaxChunkBytes, is divided into a power of
// two of chunks by the hash of each root's name, so the division changes only
// when the group's size doubles. Chunks are placed largest first, each in the
// lighter of two partitions chosen by hashes of its key, after the functions
// placed by name. The placement depends only on the module text and the
// partition count. Modules with fewer than MinGroupedPartitions partitions
// keep the placement by name, which balanceRoots evens out: with few
// partitions per core, the balance of the largest partitions decides the
// build time more than the imports.
void placeGroups(std::vector<Symbol> &Symbols, ArrayRef<unsigned> Roots,
                 unsigned Count) {
  if (Count < MinGroupedPartitions)
    return;
  auto Bytes = [](const Symbol &S) -> uint64_t {
    return S.Header.size() + S.Body.size();
  };
  std::vector<uint64_t> Load(Count, 0);
  uint64_t Total = 0;
  StringMap<uint64_t> GroupBytes;
  for (unsigned I = 0; I < Symbols.size(); ++I) {
    const Symbol &S = Symbols[I];
    if (S.Kind != SymbolKind::Function || S.Partition == NoPartition)
      continue;
    Total += Bytes(S);
    StringRef Group = Symbols[Roots[I]].Group;
    if (Group.empty())
      Load[S.Partition] += Bytes(S);
    else
      GroupBytes[Group] += Bytes(S);
  }
  if (GroupBytes.empty())
    return;
  // A chunk is at most MaxChunkBytes, so the code a partition optimizes
  // together, and the inlining within it, does not grow when a program has
  // fewer partitions.
  constexpr uint64_t MaxChunkBytes = 1024 * 1024;
  uint64_t Chunk =
      std::min(MaxChunkBytes, std::max<uint64_t>(1, Total / Count));
  std::vector<std::string> Keys(Symbols.size());
  StringMap<uint64_t> KeyBytes;
  for (unsigned I = 0; I < Symbols.size(); ++I) {
    const Symbol &S = Symbols[I];
    if (S.Kind != SymbolKind::Function || S.Partition == NoPartition)
      continue;
    StringRef Group = Symbols[Roots[I]].Group;
    if (Group.empty())
      continue;
    uint64_t Chunks = 1;
    while (Chunks * Chunk < GroupBytes[Group])
      Chunks *= 2;
    Keys[I] = Chunks == 1
                  ? Group.str()
                  : (Group + "#" +
                     Twine(stableHash(Symbols[Roots[I]].Name) % Chunks))
                        .str();
    KeyBytes[Keys[I]] += Bytes(S);
  }
  std::vector<std::pair<StringRef, uint64_t>> Order;
  for (const auto &Entry : KeyBytes)
    Order.push_back({Entry.getKey(), Entry.getValue()});
  llvm::sort(Order, [](const auto &A, const auto &B) {
    return A.second != B.second ? A.second > B.second : A.first < B.first;
  });
  StringMap<unsigned> Where;
  for (const auto &[Key, Size] : Order) {
    unsigned First = stableHash(Key) % Count;
    unsigned Second = stableHash((Key + "/2").str()) % Count;
    unsigned Chosen = Load[Second] < Load[First] ? Second : First;
    Load[Chosen] += Size;
    Where[Key] = Chosen;
  }
  for (unsigned I = 0; I < Symbols.size(); ++I)
    if (!Keys[I].empty())
      Symbols[I].Partition = Where[Keys[I]];
}

// In modules of fewer than MinGroupedPartitions partitions, which
// placeGroups leaves placed by name, the functions of each root (a
// function and the chain that follows it) move together to another partition
// when their name's partition would hold more than 1.25 times the mean
// function bytes: each root probes the next partitions in turn, keeping the
// first with room, else its own. An edit then recompiles about a mean
// partition, and the largest partition, which bounds a cold build, stays
// near the mean unless one root is larger. The roots of the entry module's
// top-level code are placed first, and their partitions take no other root,
// so an edit of the program's top level recompiles only that code. Roots
// and their bytes, and so placement, depend only on the module text.
void balanceRoots(std::vector<Symbol> &Symbols, ArrayRef<unsigned> Roots,
                  ArrayRef<char> Live, unsigned Count) {
  if (Count >= MinGroupedPartitions)
    return;
  // A root's size leaves out the digits of metadata references, which an
  // edit elsewhere in the module can renumber.
  auto TextBytes = [](StringRef Text) {
    uint64_t Bytes = 0;
    for (size_t I = 0; I < Text.size(); ++I) {
      ++Bytes;
      if (Text[I] == '!')
        while (I + 1 < Text.size() && isDigit(Text[I + 1]))
          ++I;
    }
    return Bytes;
  };
  DenseMap<unsigned, uint64_t> RootBytes;
  for (unsigned I = 0; I < Symbols.size(); ++I)
    if (Symbols[I].Kind == SymbolKind::Function && Live[I])
      RootBytes[Roots[I]] +=
          TextBytes(Symbols[I].Header) + TextBytes(Symbols[I].Body);
  std::vector<unsigned> Order;
  for (auto &Entry : RootBytes)
    Order.push_back(Entry.first);
  llvm::sort(Order, [&](unsigned A, unsigned B) {
    return Symbols[A].Name < Symbols[B].Name;
  });
  DenseSet<unsigned> EntryRoots;
  for (unsigned I = 0; I < Symbols.size(); ++I)
    if (Symbols[I].Entry && Live[I])
      EntryRoots.insert(Roots[I]);
  // A root of at least one unit counts in whole units, so that an edit that
  // grows it by less than that leaves every comparison, and every other
  // root's partition, unchanged.
  constexpr uint64_t Unit = 4096;
  uint64_t Total = 0;
  for (unsigned Root : Order)
    if (RootBytes[Root] >= Unit) {
      RootBytes[Root] = (RootBytes[Root] + Unit - 1) / Unit * Unit;
      Total += RootBytes[Root];
    }
  uint64_t Cap = Total * 5 / 4 / Count;
  std::vector<uint64_t> Load(Count, 0);
  // Partitions that take no further root.
  std::vector<char> Closed(Count, 0);
  DenseMap<unsigned, unsigned> Placed;
  auto FirstOpen = [&](unsigned Home) {
    for (unsigned K = 0; K < Count; ++K)
      if (!Closed[(Home + K) % Count])
        return (Home + K) % Count;
    return Home;
  };
  // A root without room anywhere stays in the first open partition from its
  // own.
  auto Place = [&](unsigned Root) {
    uint64_t Bytes = RootBytes[Root];
    unsigned Home = stableHash(Symbols[Root].Name) % Count;
    unsigned Chosen = FirstOpen(Home);
    for (unsigned K = 0; K < Count; ++K) {
      unsigned P = (Home + K) % Count;
      if (!Closed[P] && Load[P] + Bytes <= Cap) {
        Chosen = P;
        break;
      }
    }
    Load[Chosen] += Bytes;
    Placed[Root] = Chosen;
  };
  // Entry roots first, each closing its partition; then roots of more than
  // half the cap, in name order, so that the others fill around them; then
  // the other roots of at least one unit, in name order.
  for (unsigned Root : Order)
    if (EntryRoots.contains(Root)) {
      Place(Root);
      Closed[Placed[Root]] = 1;
    }
  for (unsigned Root : Order)
    if (!EntryRoots.contains(Root) && RootBytes[Root] >= Unit &&
        RootBytes[Root] * 2 > Cap)
      Place(Root);
  for (unsigned Root : Order)
    if (!EntryRoots.contains(Root) && RootBytes[Root] >= Unit &&
        RootBytes[Root] * 2 <= Cap)
      Place(Root);
  // Roots under one unit (runtime helpers, mostly) count in no load of the
  // larger roots, so a helper that an edit adds or removes moves no larger
  // root. Each goes to the first open partition from its name's whose load,
  // the helpers placed there included, is below the cap, or else to its
  // name's: the helpers fill the partitions with room, and once those are
  // full they spread by name instead of gathering in one partition (which
  // could then hold most of the module and have it optimized whole).
  std::vector<uint64_t> SmallLoad(Count, 0);
  for (unsigned Root : Order)
    if (!EntryRoots.contains(Root) && RootBytes[Root] < Unit) {
      unsigned Home = stableHash(Symbols[Root].Name) % Count;
      unsigned Chosen = FirstOpen(Home);
      for (unsigned K = 0; K < Count; ++K) {
        unsigned P = (Home + K) % Count;
        if (!Closed[P] && Load[P] + SmallLoad[P] < Cap) {
          Chosen = P;
          break;
        }
      }
      SmallLoad[Chosen] += RootBytes[Root];
      Placed[Root] = Chosen;
    }
  for (unsigned I = 0; I < Symbols.size(); ++I)
    if (Symbols[I].Kind == SymbolKind::Function && Live[I])
      Symbols[I].Partition = Placed[Roots[I]];
}

bool startsWithLinkage(StringRef Rest) {
  for (StringRef Linkage :
       {"linkonce", "weak", "common", "appending", "extern_weak",
        "available_externally", "external"})
    if (Rest.starts_with(Linkage))
      return true;
  return false;
}

bool hasVisibilityToken(StringRef Prefix) {
  SmallVector<StringRef, 8> Tokens;
  Prefix.split(Tokens, ' ', -1, false);
  for (StringRef Token : Tokens)
    if (Token == "dso_local" || Token == "dso_preemptable" ||
        Token == "hidden" || Token == "protected" || Token == "default" ||
        Token == "dllimport" || Token == "dllexport")
      return true;
  return false;
}

// Position of the first unquoted occurrence of Wanted, or npos.
size_t findUnquoted(StringRef Text, char Wanted) {
  bool Quoted = false;
  for (size_t I = 0; I < Text.size(); ++I) {
    if (Text[I] == '"')
      Quoted = !Quoted;
    else if (!Quoted && Text[I] == Wanted)
      return I;
  }
  return StringRef::npos;
}

bool parseFunctionHeader(StringRef Line, Symbol &S) {
  StringRef Rest = Line.drop_front(sizeof("define ") - 1);
  if (Rest.consume_front("internal ") || Rest.consume_front("private "))
    S.Local = true;
  else if (startsWithLinkage(Rest))
    return false;
  size_t At = Rest.find('@');
  if (At == StringRef::npos)
    return false;
  StringRef Prefix = Rest.take_front(At);
  if (S.Local && hasVisibilityToken(Prefix))
    return false;
  size_t Length = nameLength(Rest, At + 1);
  size_t Open = At + 1 + Length;
  if (Length == 0 || Open >= Rest.size() || Rest[Open] != '(')
    return false;
  S.Name = Rest.substr(At + 1, Length);
  size_t Depth = 0, Close = StringRef::npos;
  bool Quoted = false;
  for (size_t I = Open; I < Rest.size(); ++I) {
    char C = Rest[I];
    if (C == '"')
      Quoted = !Quoted;
    if (Quoted)
      continue;
    if (C == '(')
      ++Depth;
    else if (C == ')' && --Depth == 0) {
      Close = I;
      break;
    }
  }
  if (Close == StringRef::npos)
    return false;
  StringRef Tail = Rest.drop_front(Close + 1);
  size_t Brace = findUnquoted(Tail, '{');
  if (Brace == StringRef::npos)
    return false;
  StringRef After = Tail.drop_front(Brace + 1).ltrim();
  if (!After.empty() && After.front() != ';')
    return false;
  S.Declaration = "declare ";
  if (S.Local)
    S.Declaration += "hidden ";
  S.Declaration += Prefix;
  S.Declaration += '@';
  S.Declaration += S.Name;
  S.Declaration += Rest.slice(Open, Close + 1);
  // Attribute groups and address significance carry over. Personality,
  // sections, comdats and debug attachments belong only to the definition.
  SmallVector<StringRef, 8> Tokens;
  Tail.take_front(Brace).split(Tokens, ' ', -1, false);
  for (StringRef Token : Tokens) {
    bool Group = Token.size() > 1 && Token.front() == '#' &&
                 all_of(Token.drop_front(), isDigit);
    if (Group || Token == "unnamed_addr" || Token == "local_unnamed_addr") {
      S.Declaration += ' ';
      S.Declaration += Token;
    }
  }
  if (S.Local)
    S.PromotedHeader = (Twine("define hidden ") + Rest).str();
  return true;
}

// Parses `@name = ...`. Returns false for unsupported forms.
bool parseGlobal(StringRef Line, Symbol &S) {
  size_t Length = nameLength(Line, 1);
  if (Length == 0)
    return false;
  S.Name = Line.substr(1, Length);
  StringRef Rest = Line.drop_front(1 + Length);
  if (!Rest.consume_front(" = "))
    return false;
  if (Rest.starts_with("external ") || Rest.starts_with("extern_weak ")) {
    S.Kind = SymbolKind::Declaration;
    return true;
  }
  S.Kind = SymbolKind::Variable;
  if (Rest.consume_front("internal ") || Rest.consume_front("private "))
    S.Local = true;
  else if (startsWithLinkage(Rest))
    return false;
  StringRef Cursor = Rest;
  std::string Qualifiers;
  StringRef Keyword;
  while (true) {
    if (Cursor.consume_front("global ")) {
      Keyword = "global";
      break;
    }
    if (Cursor.consume_front("constant ")) {
      Keyword = "constant";
      S.Constant = true;
      break;
    }
    size_t Space = Cursor.find(' ');
    if (Space == StringRef::npos)
      return false;
    StringRef Token = Cursor.take_front(Space);
    if (Token == "dso_local" || Token == "hidden" || Token == "protected" ||
        Token == "default") {
      if (S.Local)
        return false;
      Qualifiers += Token;
      Qualifiers += ' ';
    } else if (Token.starts_with("thread_local") ||
               Token.starts_with("addrspace(")) {
      Qualifiers += Token;
      Qualifiers += ' ';
    } else if (Token != "unnamed_addr" && Token != "local_unnamed_addr" &&
               Token != "externally_initialized") {
      return false;
    }
    Cursor = Cursor.drop_front(Space + 1);
  }
  // The value type ends at the first space outside brackets.
  int Depth = 0;
  size_t TypeEnd = StringRef::npos;
  for (size_t I = 0; I < Cursor.size(); ++I) {
    char C = Cursor[I];
    if (C == '{' || C == '[' || C == '<' || C == '(')
      ++Depth;
    else if (C == '}' || C == ']' || C == '>' || C == ')')
      --Depth;
    else if (C == ' ' && Depth == 0) {
      TypeEnd = I;
      break;
    }
  }
  if (TypeEnd == StringRef::npos)
    return false;
  S.Declaration = (Twine("@") + S.Name + " = external " + (S.Local ? "hidden " : "") +
                   Qualifiers + Keyword + " " + Cursor.take_front(TypeEnd))
                      .str();
  if (S.Local)
    S.PromotedHeader = (Twine("@") + S.Name + " = hidden " + Rest).str();
  return true;
}

// Collects the symbols (sorted) and metadata nodes (in order of first
// appearance) that Text references outside quoted strings, and in Calls the
// symbols it names as direct callees, which the emitter writes followed by
// "(".
void scanReferences(StringRef Text, const StringMap<unsigned> &Index,
                    std::vector<unsigned> &Refs,
                    std::vector<unsigned> &Metadata,
                    std::vector<unsigned> *Calls = nullptr) {
  DenseSet<unsigned> Seen(Metadata.begin(), Metadata.end());
  bool Quoted = false;
  for (size_t I = 0; I < Text.size(); ++I) {
    char C = Text[I];
    if (C == '\n') {
      Quoted = false;
    } else if (C == '"') {
      Quoted = !Quoted;
    } else if (Quoted) {
      continue;
    } else if (C == '@') {
      size_t Length = nameLength(Text, I + 1);
      if (Length != 0) {
        auto It = Index.find(Text.substr(I + 1, Length));
        if (It != Index.end()) {
          Refs.push_back(It->second);
          if (Calls && I + 1 + Length < Text.size() &&
              Text[I + 1 + Length] == '(')
            Calls->push_back(It->second);
        }
        I += Length;
      }
    } else if (C == '!' && I + 1 < Text.size() && isDigit(Text[I + 1])) {
      unsigned Number = 0;
      size_t J = I + 1;
      for (; J < Text.size() && isDigit(Text[J]); ++J)
        Number = Number * 10 + static_cast<unsigned>(Text[J] - '0');
      if (Seen.insert(Number).second)
        Metadata.push_back(Number);
      I = J - 1;
    }
  }
  llvm::sort(Refs);
  Refs.erase(std::unique(Refs.begin(), Refs.end()), Refs.end());
  if (Calls) {
    llvm::sort(*Calls);
    Calls->erase(std::unique(Calls->begin(), Calls->end()), Calls->end());
  }
}

// Appends Text with every unquoted metadata reference renumbered by Map.
void appendRenumbered(StringRef Text, const DenseMap<unsigned, unsigned> &Map,
                      std::string &Out) {
  bool Quoted = false;
  size_t Copied = 0;
  for (size_t I = 0; I < Text.size(); ++I) {
    char C = Text[I];
    if (C == '\n') {
      Quoted = false;
    } else if (C == '"') {
      Quoted = !Quoted;
    } else if (!Quoted && C == '!' && I + 1 < Text.size() &&
               isDigit(Text[I + 1])) {
      unsigned Number = 0;
      size_t J = I + 1;
      for (; J < Text.size() && isDigit(Text[J]); ++J)
        Number = Number * 10 + static_cast<unsigned>(Text[J] - '0');
      auto It = Map.find(Number);
      if (It != Map.end()) {
        Out.append(Text.data() + Copied, I + 1 - Copied);
        Out += std::to_string(It->second);
        Copied = J;
      }
      I = J - 1;
    }
  }
  Out.append(Text.data() + Copied, Text.size() - Copied);
}

} // namespace

bool dominatedPartitions(ArrayRef<uint64_t> FunctionBytes) {
  uint64_t Total = 0, Largest = 0;
  for (uint64_t Bytes : FunctionBytes) {
    Total += Bytes;
    Largest = std::max(Largest, Bytes);
  }
  return Largest * 3 > Total * 2;
}

std::optional<ProgramPartitions> partitionProgramText(StringRef Text,
                                                      unsigned Count,
                                                      bool SkipDominated) {
  if (Count < 2)
    return std::nullopt;
  std::vector<StringRef> Header, Types, Attributes, NamedMetadata;
  std::vector<unsigned> CompileUnits;
  DenseMap<unsigned, MetadataNode> Metadata;
  std::vector<Symbol> Symbols;
  StringMap<unsigned> Index;

  auto Add = [&](Symbol S) {
    if (!Index.try_emplace(S.Name, Symbols.size()).second)
      return false;
    Symbols.push_back(std::move(S));
    return true;
  };

  // The emitter writes "; scriptc-group <key>" before the definitions of each
  // source function; the group applies until the next such line, and an
  // empty key ends it. It writes "; scriptc-entry" before the definition of
  // the entry module's top-level code.
  constexpr StringRef GroupLine = "; scriptc-group";
  constexpr StringRef EntryLine = "; scriptc-entry";
  StringRef Group;
  bool Entry = false;
  size_t Pos = 0;
  while (Pos < Text.size()) {
    size_t End = Text.find('\n', Pos);
    if (End == StringRef::npos)
      End = Text.size();
    StringRef Line = Text.slice(Pos, End);
    size_t Next = End + 1;
    if (Line.empty() || Line.trim().empty()) {
      // Blank separator.
    } else if (Line.starts_with(GroupLine) &&
               (Line.size() == GroupLine.size() ||
                Line[GroupLine.size()] == ' ')) {
      Group = Line.drop_front(GroupLine.size()).trim();
    } else if (Line.trim() == EntryLine) {
      Entry = true;
    } else if (Line.starts_with("define ")) {
      Symbol S;
      S.Kind = SymbolKind::Function;
      S.Header = Line;
      S.Group = Group;
      S.Entry = Entry;
      Entry = false;
      if (!parseFunctionHeader(Line, S))
        return std::nullopt;
      // The emitter indents every body line, so the first line that is
      // exactly "}" closes the function.
      size_t Close = End;
      while (true) {
        Close = Text.find("\n}", Close);
        if (Close == StringRef::npos)
          return std::nullopt;
        if (Close + 2 == Text.size() || Text[Close + 2] == '\n')
          break;
        Close += 2;
      }
      S.Body = Text.slice(std::min(End + 1, Text.size()), Close + 2);
      Next = Close + 3;
      if (!Add(std::move(S)))
        return std::nullopt;
    } else if (Line.front() == '@') {
      Symbol S;
      S.Header = Line;
      if (!parseGlobal(Line, S))
        return std::nullopt;
      // The emitter writes an interface dispatch table one element per
      // line: the definition opens its aggregate initializer at the end of
      // the line, and a line that is only the closing bracket ends it.
      StringRef Opening = Line.rtrim();
      if (S.Kind == SymbolKind::Variable &&
          (Opening.ends_with(" [") || Opening.ends_with(" {"))) {
        StringRef Close = Opening.back() == '[' ? "]" : "}";
        size_t Cursor = Next;
        while (true) {
          if (Cursor >= Text.size())
            return std::nullopt;
          size_t LineEnd = Text.find('\n', Cursor);
          if (LineEnd == StringRef::npos)
            LineEnd = Text.size();
          StringRef Element = Text.slice(Cursor, LineEnd);
          if (Element == Close) {
            S.Body = Text.slice(Next, LineEnd);
            Next = LineEnd + 1;
            break;
          }
          if (!Element.starts_with("  "))
            return std::nullopt;
          Cursor = LineEnd + 1;
        }
      }
      if (!Add(std::move(S)))
        return std::nullopt;
    } else if (Line.starts_with("declare ")) {
      Symbol S;
      S.Header = Line;
      size_t At = Line.find('@');
      size_t Length = At == StringRef::npos ? 0 : nameLength(Line, At + 1);
      if (Length == 0)
        return std::nullopt;
      S.Name = Line.substr(At + 1, Length);
      if (!Add(std::move(S)))
        return std::nullopt;
    } else if (Line.front() == '%') {
      if (Line.find(" = type ") == StringRef::npos)
        return std::nullopt;
      Types.push_back(Line);
    } else if (Line.starts_with("attributes #")) {
      Attributes.push_back(Line);
    } else if (Line.front() == '!') {
      if (Line.size() > 1 && isDigit(Line[1])) {
        unsigned Number = 0;
        size_t I = 1;
        for (; I < Line.size() && isDigit(Line[I]); ++I)
          Number = Number * 10 + static_cast<unsigned>(Line[I] - '0');
        if (!Line.drop_front(I).starts_with(" = "))
          return std::nullopt;
        if (!Metadata.try_emplace(Number, MetadataNode{Line, {}, {}}).second)
          return std::nullopt;
      } else if (Line.starts_with("!llvm.dbg.cu = !{")) {
        // Each partition lists only the compile units its functions use.
        std::vector<unsigned> Unused;
        scanReferences(Line, Index, Unused, CompileUnits);
      } else {
        NamedMetadata.push_back(Line);
      }
    } else if (Line.front() == ';' || Line.starts_with("source_filename ") ||
               Line.starts_with("target ")) {
      Header.push_back(Line);
    } else {
      return std::nullopt;
    }
    Pos = Next;
  }

  for (Symbol &S : Symbols) {
    if (S.Kind == SymbolKind::Declaration)
      continue;
    scanReferences(S.Header, Index, S.Refs, S.Metadata);
    if (!S.Body.empty()) {
      std::vector<unsigned> Refs;
      scanReferences(S.Body, Index, Refs, S.Metadata, &S.Calls);
      S.Refs.insert(S.Refs.end(), Refs.begin(), Refs.end());
      llvm::sort(S.Refs);
      S.Refs.erase(std::unique(S.Refs.begin(), S.Refs.end()), S.Refs.end());
    }
  }

  // Metadata nodes are numbered in the emitter's global order, so one added
  // node would renumber the references in every partition. Each partition
  // instead numbers the nodes it uses in order of first use, which keeps an
  // unchanged partition's text, and therefore its cached artifacts, intact.
  for (auto &Entry : Metadata) {
    MetadataNode &Node = Entry.second;
    size_t Equals = Node.Line.find(" = ");
    scanReferences(Node.Line.drop_front(Equals + 3), Index, Node.Symbols,
                   Node.Refs);
  }
  std::vector<unsigned> NamedRoots, NamedSymbols;
  for (StringRef Line : NamedMetadata)
    scanReferences(Line, Index, NamedSymbols, NamedRoots);

  // An internal definition that no other definition reaches is left out of
  // every partition: the optimizer would delete it, and the emitter writes
  // variants of helpers that the program never calls. Leaving them out
  // shortens every partition's parse, summary and optimization, and since
  // placement ignores them too, an edit that adds one changes no partition.
  std::vector<char> Live(Symbols.size(), 0);
  {
    std::vector<unsigned> Work;
    auto Reach = [&](unsigned I) {
      if (!Live[I]) {
        Live[I] = 1;
        Work.push_back(I);
      }
    };
    for (unsigned I = 0; I < Symbols.size(); ++I)
      if (Symbols[I].Kind != SymbolKind::Declaration && !Symbols[I].Local)
        Reach(I);
    for (unsigned I : NamedSymbols)
      Reach(I);
    for (auto &Entry : Metadata)
      for (unsigned I : Entry.second.Symbols)
        Reach(I);
    while (!Work.empty()) {
      unsigned I = Work.back();
      Work.pop_back();
      for (unsigned Ref : Symbols[I].Refs)
        Reach(Ref);
    }
  }

  // An internal definition reached from exactly one other definition is an
  // inlining candidate of it, or data only it uses; keep it with that
  // definition so its partition can inline it without importing, and so a
  // helper an edit adds lands in the partition of the code that uses it. A
  // function that its referrer only takes the address of is not an inlining
  // candidate: a closure body whose address its creator passes to the
  // runtime, or a compiled regular expression's matcher that a mutable
  // global points to, gives the referrer nothing to inline, and joining it
  // would make every edit of the referrer optimize it again. Such a function
  // is placed by its own name, unless its body is under AddressOnlyBytes (a
  // trampoline or thread entry, which costs little to optimize again). A
  // chain through a constant global, whose loads the optimizer can turn into
  // direct calls, continues to the function that uses the global.
  // A function body larger than this is past LLVM's inline cost limit even
  // for the only call to a local function, so it is placed by its own name.
  // A chain stops where it would leave a function's source-module group for
  // a function outside every group. In a module of more than
  // GroupedChainBytes of LLVM text, it also stops where it would join a
  // function of another group: module initializers, which only the entry
  // point calls, keep their own partitions instead of all sharing the entry
  // point's. In a smaller module, a function that one function of another
  // source file calls stays with it, so it can still be inlined there as in
  // the whole module; when that gathers most of the program into one
  // partition, the program is optimized whole (see emitPartitions).
  constexpr size_t MaxInlinedBodyBytes = 256 * 1024;
  constexpr size_t GroupedChainBytes = 1024 * 1024;
  constexpr size_t AddressOnlyBytes = 512;
  bool GroupedChains = Text.size() > GroupedChainBytes;
  constexpr unsigned Shared = ~1u;
  std::vector<unsigned> Referrer(Symbols.size(), NoPartition);
  // Whether a definition may follow its first referrer: it is not a
  // function, or the referrer calls it or is a constant global, or its body
  // is under AddressOnlyBytes. A fallback body (isPlacedByName) is never
  // inlined, so it is placed by its own name: following its caller would add
  // its body to the partition that holds the code it stands in for, which is
  // often the largest.
  std::vector<char> MayFollow(Symbols.size(), 0);
  for (unsigned I = 0; I < Symbols.size(); ++I) {
    const Symbol &S = Symbols[I];
    if (S.Kind == SymbolKind::Declaration || !Live[I])
      continue;
    for (unsigned Ref : S.Refs) {
      if (Ref == I)
        continue;
      if (Referrer[Ref] == NoPartition) {
        Referrer[Ref] = I;
        MayFollow[Ref] =
            Symbols[Ref].Kind != SymbolKind::Function ||
            Symbols[Ref].Body.size() < AddressOnlyBytes ||
            (!isPlacedByName(Symbols[Ref].Header) &&
             (S.Kind == SymbolKind::Function
                  ? std::binary_search(S.Calls.begin(), S.Calls.end(), Ref)
                  : S.Constant));
      } else {
        Referrer[Ref] = Shared;
      }
    }
  }
  auto Follows = [&](unsigned Child, unsigned Parent) {
    const Symbol &S = Symbols[Child];
    if (!S.Local || !MayFollow[Child] || Parent == NoPartition ||
        Parent == Shared || Symbols[Parent].Kind == SymbolKind::Declaration)
      return false;
    if (S.Kind == SymbolKind::Function &&
        (S.Body.size() > MaxInlinedBodyBytes ||
         (Symbols[Parent].Kind == SymbolKind::Function && !S.Group.empty() &&
          S.Group != Symbols[Parent].Group &&
          (GroupedChains || Symbols[Parent].Group.empty()))))
      return false;
    return true;
  };
  std::vector<unsigned> Roots(Symbols.size());
  for (unsigned I = 0; I < Symbols.size(); ++I) {
    if (Symbols[I].Kind == SymbolKind::Declaration || !Live[I])
      continue;
    unsigned Root = I;
    for (unsigned Steps = 0; Steps < 1024; ++Steps) {
      unsigned Parent = Referrer[Root];
      if (!Follows(Root, Parent) || Parent == I)
        break;
      Root = Parent;
    }
    // A function whose chain ends at a global that is not itself placed
    // with a function (a table many functions use) is placed by its own
    // name, so the functions of one table spread over the partitions.
    if (Symbols[I].Kind == SymbolKind::Function &&
        Symbols[Root].Kind != SymbolKind::Function)
      Root = I;
    Roots[I] = Root;
  }
  // The x86-64-v3 copy of a function with CPU copies (`<name>.v3`),
  // with the chain that ends at it, is placed with the chain of its baseline
  // copy (`<name>.base`), so that the helper can compare the two copies
  // after optimization (cpu-copies.h).
  DenseMap<unsigned, unsigned> CopyRoots;
  for (unsigned I = 0; I < Symbols.size(); ++I) {
    StringRef Name = Symbols[I].Name;
    if (Symbols[I].Kind != SymbolKind::Function || !Live[I] ||
        Roots[I] != I || !Name.consume_back(".v3"))
      continue;
    auto Base = Index.find((Name + ".base").str());
    if (Base != Index.end() && Live[Base->second] &&
        Symbols[Base->second].Kind == SymbolKind::Function)
      CopyRoots[I] = Roots[Base->second];
  }
  for (unsigned I = 0; I < Symbols.size(); ++I) {
    if (Symbols[I].Kind == SymbolKind::Declaration || !Live[I])
      continue;
    auto Copy = CopyRoots.find(Roots[I]);
    if (Copy != CopyRoots.end())
      Roots[I] = Copy->second;
    if (Symbols[I].Kind == SymbolKind::Function)
      Symbols[I].Partition = stableHash(Symbols[Roots[I]].Name) % Count;
  }
  placeGroups(Symbols, Roots, Count);
  balanceRoots(Symbols, Roots, Live, Count);
  // A global follows the function its chain ends at, then the first
  // function that references it, then its own name.
  for (unsigned I = 0; I < Symbols.size(); ++I)
    if (Symbols[I].Kind == SymbolKind::Variable && Live[I] &&
        Symbols[Roots[I]].Kind == SymbolKind::Function)
      Symbols[I].Partition = Symbols[Roots[I]].Partition;
  for (unsigned I = 0; I < Symbols.size(); ++I) {
    const Symbol &S = Symbols[I];
    if (S.Kind != SymbolKind::Function || !Live[I])
      continue;
    for (unsigned Ref : S.Refs)
      if (Symbols[Ref].Kind == SymbolKind::Variable &&
          Symbols[Ref].Partition == NoPartition)
        Symbols[Ref].Partition = S.Partition;
  }
  for (unsigned I = 0; I < Symbols.size(); ++I)
    if (Symbols[I].Kind == SymbolKind::Variable && Live[I] &&
        Symbols[I].Partition == NoPartition)
      Symbols[I].Partition = stableHash(Symbols[I].Name) % Count;

  ProgramPartitions Result;
  for (const Symbol &S : Symbols)
    if (S.Kind != SymbolKind::Declaration && !S.Local)
      Result.PublicSymbols.insert(S.Name);

  Result.Sources.resize(Count);
  Result.FunctionBytes.assign(Count, 0);
  std::vector<std::vector<unsigned>> Owned(Count);
  for (unsigned I = 0; I < Symbols.size(); ++I)
    if (Symbols[I].Kind != SymbolKind::Declaration && Live[I]) {
      Owned[Symbols[I].Partition].push_back(I);
      if (Symbols[I].Kind == SymbolKind::Function)
        Result.FunctionBytes[Symbols[I].Partition] +=
            Symbols[I].Header.size() + Symbols[I].Body.size();
    }
  // The caller optimizes such a module whole, so its partitions' text is
  // not needed.
  if (SkipDominated && dominatedPartitions(Result.FunctionBytes)) {
    Result.Sources.clear();
    return Result;
  }

  // An internal definition stays internal, so its partition's optimizer can
  // inline a function into its last caller and delete it as the whole module
  // would. It is promoted to hidden visibility only when a definition of
  // another partition or a metadata node names it.
  std::vector<char> Exported(Symbols.size(), 0);
  for (unsigned I : NamedSymbols)
    Exported[I] = 1;
  for (auto &Entry : Metadata)
    for (unsigned I : Entry.second.Symbols)
      Exported[I] = 1;
  for (unsigned I = 0; I < Symbols.size(); ++I) {
    const Symbol &S = Symbols[I];
    if (S.Kind == SymbolKind::Declaration || !Live[I])
      continue;
    for (unsigned Ref : S.Refs)
      if (Symbols[Ref].Kind != SymbolKind::Declaration &&
          Symbols[Ref].Partition != S.Partition)
        Exported[Ref] = 1;
  }

  auto Assemble = [&](unsigned P) {
    std::vector<char> Needed(Symbols.size(), 0);
    DenseMap<unsigned, unsigned> Renumber;
    std::vector<unsigned> Nodes;
    auto Use = [&](ArrayRef<unsigned> Numbers) {
      for (unsigned Number : Numbers)
        if (Metadata.count(Number) &&
            Renumber.try_emplace(Number, Nodes.size()).second)
          Nodes.push_back(Number);
    };
    Use(NamedRoots);
    for (unsigned Ref : NamedSymbols)
      Needed[Ref] = 1;
    size_t Bytes = 0;
    for (SymbolKind Kind : {SymbolKind::Variable, SymbolKind::Function})
      for (unsigned I : Owned[P])
        if (Symbols[I].Kind == Kind) {
          const Symbol &S = Symbols[I];
          for (unsigned Ref : S.Refs)
            Needed[Ref] = 1;
          Use(S.Metadata);
          Bytes += S.Header.size() + S.Body.size() + 2;
        }
    for (size_t K = 0; K < Nodes.size(); ++K) {
      const MetadataNode &Node = Metadata.find(Nodes[K])->second;
      Use(Node.Refs);
      for (unsigned Ref : Node.Symbols)
        Needed[Ref] = 1;
    }

    std::string &Out = Result.Sources[P];
    Out.reserve(Bytes + (Bytes >> 3));
    auto Line = [&](StringRef Text) {
      if (Renumber.empty())
        Out += Text;
      else
        appendRenumbered(Text, Renumber, Out);
      Out += '\n';
    };
    for (StringRef Text : Header)
      Line(Text);
    for (StringRef Text : Types)
      Line(Text);
    // Declarations follow name order rather than the emitter's first-use
    // order, which an edit elsewhere in the program can change.
    std::vector<unsigned> Declared;
    for (unsigned I = 0; I < Symbols.size(); ++I)
      if (Needed[I] && (Symbols[I].Kind == SymbolKind::Declaration ||
                        Symbols[I].Partition != P))
        Declared.push_back(I);
    llvm::sort(Declared, [&](unsigned A, unsigned B) {
      return Symbols[A].Name < Symbols[B].Name;
    });
    for (unsigned I : Declared) {
      const Symbol &S = Symbols[I];
      Line(S.Kind == SymbolKind::Declaration ? S.Header
                                             : StringRef(S.Declaration));
    }
    for (SymbolKind Kind : {SymbolKind::Variable, SymbolKind::Function})
      for (unsigned I : Owned[P]) {
        const Symbol &S = Symbols[I];
        if (S.Kind != Kind)
          continue;
        Line(S.Local && Exported[I] ? StringRef(S.PromotedHeader) : S.Header);
        if (!S.Body.empty())
          Line(S.Body);
      }
    for (StringRef Text : Attributes)
      Line(Text);
    for (StringRef Text : NamedMetadata)
      Line(Text);
    std::string Units;
    for (unsigned Unit : CompileUnits) {
      auto It = Renumber.find(Unit);
      if (It == Renumber.end())
        continue;
      Units += Units.empty() ? "!" : ", !";
      Units += std::to_string(It->second);
    }
    if (!Units.empty())
      Out += "!llvm.dbg.cu = !{" + Units + "}\n";
    for (size_t K = 0; K < Nodes.size(); ++K) {
      StringRef Text = Metadata.find(Nodes[K])->second.Line;
      Out += '!';
      Out += std::to_string(K);
      Line(Text.drop_front(Text.find(" = ")));
    }
  };
  DefaultThreadPool Pool(hardware_concurrency());
  for (unsigned P = 0; P < Count; ++P)
    Pool.async([&Assemble, P] { Assemble(P); });
  Pool.wait();
  return Result;
}

} // namespace scriptc
