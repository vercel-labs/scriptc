#pragma once

namespace scriptc {

// `merge-profiles --output <file.profdata> [--sparse] <input>...`: merges raw
// (.profraw) or indexed (.profdata) IR profiles into one indexed profile.
// --sparse leaves out functions that never ran.
int mergeProfiles(int Argc, char **Argv);

} // namespace scriptc
