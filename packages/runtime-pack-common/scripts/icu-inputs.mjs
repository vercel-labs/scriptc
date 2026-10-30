// The pinned ICU4C 78.3 inputs of the runtime packs. ICU is the one build
// input that is not vendored: both the source tarball and the prebuilt data
// zip come from unicode-org/icu's official GitHub release for the pinned
// version, each pinned by version and sha256, and both are cached on disk
// (see icu-data.mjs, which also fetches them).
// packages/compiler/src/backend/vendor-inputs.ts keeps the same pins for the
// source-build path; a unit test checks that the two agree.

/** Node v24.22.0 bundles ICU 78.3 (`process.versions.icu`). */
export const ICU_VERSION = "78.3";

const RELEASE_URL = `https://github.com/unicode-org/icu/releases/download/release-${ICU_VERSION}`;

export const ICU_SOURCE_URL = `${RELEASE_URL}/icu4c-${ICU_VERSION}-sources.tgz`;
export const ICU_SOURCE_SHA256 = "3a2e7a47604ba702f345878308e6fefeca612ee895cf4a5f222e7955fabfe0c0";
export const ICU_SOURCE_SIZE = 27_977_255;

export const ICU_DATA_URL = `${RELEASE_URL}/icu4c-${ICU_VERSION}-data-bin-l.zip`;
export const ICU_DATA_ZIP_SHA256 =
  "982619632b78887f1895b063e96e8c3cc7f99283337c8abbd05aa71635de613c";
export const ICU_DATA_ZIP_SIZE = 12_836_659;
export const ICU_DATA_FILE = "icudt78l.dat";
export const ICU_DATA_SHA256 = "d5cf2a40dccbe471781ec7af85693bff542ff12f0b670c9630c4e72d60714b8b";
export const ICU_DATA_SIZE = 33_107_232;
