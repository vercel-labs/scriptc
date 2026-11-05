#pragma once

namespace scriptc {

// `merge-profiles --output <file.profdata> [--sparse] [--keep-functions
// <file>] <input>...`: merges raw (.profraw) or indexed (.profdata) IR
// profiles into one indexed profile. --sparse leaves out functions that never
// ran, and --keep-functions every function the file does not name.
int mergeProfiles(int Argc, char **Argv);

// `profile-functions --input <file.profdata>`: prints the names of the
// functions an indexed profile has records for, as {"ok":true,"functions":[]}.
int profileFunctions(int Argc, char **Argv);

} // namespace scriptc
