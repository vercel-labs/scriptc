#pragma once

#include "llvm/ADT/StringMap.h"
#include "llvm/ADT/StringRef.h"

#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace llvm {
class Function;
class ProfileSummaryInfo;
} // namespace llvm

namespace scriptc {

// A profile's block counts (a .blocks file), which annotate the functions
// whose control flow changed since the profile was collected. The profile
// annotation matches a function only when its control flow hashes as it did
// then; the block counts describe each function by its blocks' labels, which
// an unrelated change to the function leaves mostly as they were.
//
// The file is text. Its first line is `scriptc-profile-blocks 1`; each
// function follows as a line `f <name> <entry count> <blocks>` and then one
// line per block in the function's order: `<label> <count>` and, per
// successor, `<position>:<edge count>`, where the position is the
// successor's place in the function's block list. Names and labels escape
// spaces, control characters, backslashes and non-ASCII bytes as `\hh`; an
// empty label is a single backslash.

// One block of a function's record.
struct BlockRecord {
  std::string Label;
  uint64_t Count = 0;
  // Successor positions with the count of the edge to each.
  std::vector<std::pair<uint32_t, uint64_t>> Successors;
};

// One function's record: its entry count and blocks. A function that never
// ran has an entry count of zero and no blocks.
struct FunctionBlocks {
  uint64_t EntryCount = 0;
  std::vector<BlockRecord> Blocks;
};

using BlockCounts = llvm::StringMap<FunctionBlocks>;

// Reads a .blocks file; the error describes a file that does not parse.
std::unique_ptr<BlockCounts> readProfileBlocks(llvm::StringRef Path,
                                                 std::string &Error);

// Annotates F, which the profile left without counts, from its record:
// blocks that keep their place in the function's labeled block order take
// their recorded counts, and their edges the recorded edge counts, by target
// or, between targets that lost their place, by position. The counts of the
// other blocks and edges follow from flow conservation, which avoids the
// edges the function's own branch weights make unlikely. Sets the entry
// count, branch weights and the hot or cold attribute as the profile
// annotation does.
void annotateFromBlocks(llvm::Function &F, const FunctionBlocks &Record,
                        const llvm::ProfileSummaryInfo &Summary);

// The records of the functions a profile annotated, collected from every
// partition and written as one .blocks file in name order.
class BlockRecorder {
public:
  // Records F's block counts, which the profile annotation just gave it.
  void add(const llvm::Function &F);
  // Records F, which the profile has no record of, as never run.
  void addNeverRan(const llvm::Function &F);
  // Writes the file through a private sibling; returns an error message on
  // failure.
  std::optional<std::string> write(llvm::StringRef Path);

private:
  std::mutex Lock;
  std::map<std::string, std::string> Records;
};

} // namespace scriptc
