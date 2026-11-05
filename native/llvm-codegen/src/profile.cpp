#include "profile.h"
#include "diagnostics.h"

#include "llvm/ADT/SmallString.h"
#include "llvm/ADT/StringSet.h"
#include "llvm/ADT/StringRef.h"
#include "llvm/ProfileData/InstrProfReader.h"
#include "llvm/ProfileData/InstrProfWriter.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/FormatVariadic.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/VirtualFileSystem.h"
#include "llvm/Support/raw_ostream.h"

#include <string>
#include <vector>

using namespace llvm;

namespace scriptc {

int mergeProfiles(int Argc, char **Argv) {
  std::string Output;
  bool Sparse = false;
  std::string KeepFunctions;
  std::vector<std::string> Inputs;
  for (int I = 2; I < Argc; ++I) {
    StringRef Arg(Argv[I]);
    if (Arg == "--output" && I + 1 < Argc)
      Output = Argv[++I];
    else if (Arg == "--sparse")
      Sparse = true;
    else if (Arg == "--keep-functions" && I + 1 < Argc)
      KeepFunctions = Argv[++I];
    else if (!Arg.starts_with("--"))
      Inputs.push_back(Arg.str());
    else
      return reportError("usage", "merge-profiles requires --output <file> "
                                  "and one or more input profiles, and "
                                  "accepts --sparse and --keep-functions "
                                  "<file>");
  }
  if (Output.empty() || Inputs.empty())
    return reportError("usage", "merge-profiles requires --output <file> and "
                                "one or more input profiles");

  // --keep-functions names the functions to keep, one profile name per
  // line; the records of every other function are left out.
  StringSet<> Kept;
  if (!KeepFunctions.empty()) {
    ErrorOr<std::unique_ptr<MemoryBuffer>> List =
        MemoryBuffer::getFile(KeepFunctions);
    if (!List)
      return reportError("profile_read_failed",
                         KeepFunctions + ": " + List.getError().message());
    SmallVector<StringRef, 0> Names;
    (*List)->getBuffer().split(Names, '\n', -1, /*KeepEmpty=*/false);
    for (StringRef Name : Names)
      Kept.insert(Name);
  }

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
      if (!KeepFunctions.empty() && !Kept.contains(Record.Name))
        continue;
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

int profileFunctions(int Argc, char **Argv) {
  if (Argc != 4 || StringRef(Argv[2]) != "--input")
    return reportError("usage",
                       "profile-functions requires --input <file.profdata>");
  std::string Path = Argv[3];
  IntrusiveRefCntPtr<vfs::FileSystem> FS = vfs::getRealFileSystem();
  Expected<std::unique_ptr<InstrProfReader>> Reader =
      InstrProfReader::create(Path, *FS);
  if (!Reader)
    return reportError("profile_read_failed",
                       Path + ": " + toString(Reader.takeError()));
  json::Array Functions;
  for (const NamedInstrProfRecord &Record : **Reader)
    Functions.push_back(Record.Name.str());
  if ((*Reader)->hasError())
    return reportError("profile_read_failed",
                       Path + ": " + toString((*Reader)->getError()));
  json::Object Response{{"ok", true}, {"functions", std::move(Functions)}};
  outs() << formatv("{0}\n", json::Value(std::move(Response)));
  return 0;
}

} // namespace scriptc
