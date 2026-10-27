#include "profile.h"
#include "diagnostics.h"

#include "llvm/ADT/SmallString.h"
#include "llvm/ADT/StringRef.h"
#include "llvm/ProfileData/InstrProfReader.h"
#include "llvm/ProfileData/InstrProfWriter.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/VirtualFileSystem.h"
#include "llvm/Support/raw_ostream.h"

#include <string>
#include <vector>

using namespace llvm;

namespace scriptc {

int mergeProfiles(int Argc, char **Argv) {
  std::string Output;
  bool Sparse = false;
  std::vector<std::string> Inputs;
  for (int I = 2; I < Argc; ++I) {
    StringRef Arg(Argv[I]);
    if (Arg == "--output" && I + 1 < Argc)
      Output = Argv[++I];
    else if (Arg == "--sparse")
      Sparse = true;
    else if (!Arg.starts_with("--"))
      Inputs.push_back(Arg.str());
    else
      return reportError("usage", "merge-profiles requires --output <file> "
                                  "and one or more input profiles, and "
                                  "accepts --sparse");
  }
  if (Output.empty() || Inputs.empty())
    return reportError("usage", "merge-profiles requires --output <file> and "
                                "one or more input profiles");

  // Sparse profiles leave out the functions that never ran, which then
  // optimize as without a profile instead of as cold.
  InstrProfWriter Writer(Sparse);
  IntrusiveRefCntPtr<vfs::FileSystem> FS = vfs::getRealFileSystem();
  for (const std::string &Path : Inputs) {
    Expected<std::unique_ptr<InstrProfReader>> Reader =
        InstrProfReader::create(Path, *FS);
    if (!Reader)
      return reportError("profile_read_failed",
                         Path + ": " + toString(Reader.takeError()));
    if (Error E = Writer.mergeProfileKind((*Reader)->getProfileKind()))
      return reportError("profile_merge_failed",
                         Path + ": " + toString(std::move(E)));
    std::string RecordError;
    for (NamedInstrProfRecord &Record : **Reader) {
      Writer.addRecord(std::move(Record), /*Weight=*/1, [&](Error E) {
        if (RecordError.empty())
          RecordError = toString(std::move(E));
        else
          consumeError(std::move(E));
      });
    }
    if ((*Reader)->hasError())
      return reportError("profile_read_failed",
                         Path + ": " + toString((*Reader)->getError()));
    if (!RecordError.empty())
      return reportError("profile_merge_failed", Path + ": " + RecordError);
  }

  // Publish through a uniquely named sibling file, which createUniqueFile
  // creates exclusively, as emission does.
  SmallString<256> Temporary(Output);
  Temporary += ".tmp-%%%%%%";
  int Fd = -1;
  if (std::error_code EC = sys::fs::createUniqueFile(Temporary, Fd, Temporary))
    return reportError("output_open_failed", EC.message());
  {
    raw_fd_ostream Stream(Fd, /*shouldClose=*/true);
    Error WriteError = Writer.write(Stream);
    Stream.flush();
    std::string StreamError;
    if (Stream.has_error()) {
      StreamError = Stream.error().message();
      Stream.clear_error();
    }
    if (WriteError) {
      sys::fs::remove(Temporary);
      return reportError("profile_write_failed",
                         toString(std::move(WriteError)));
    }
    if (!StreamError.empty()) {
      sys::fs::remove(Temporary);
      return reportError("output_write_failed", StreamError);
    }
  }
  if (std::error_code EC = sys::fs::rename(Temporary, Output)) {
    sys::fs::remove(Temporary);
    return reportError("output_publish_failed", EC.message());
  }
  outs() << "{\"ok\":true}\n";
  return 0;
}

} // namespace scriptc
