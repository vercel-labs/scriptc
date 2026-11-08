// The pinned ICU4C 78.3 inputs of the runtime packs. ICU is the one build
// input that is not vendored: both the source tarball and the prebuilt data
// zip come from unicode-org/icu's official GitHub release for the pinned
// version, each pinned by version and sha256, and both are cached on disk
// (see icu-data.mjs, which also fetches them).
// packages/compiler/src/backend/vendor-inputs.ts keeps the same pins for the
// source-build path; a unit test checks that the two agree.

/** Node v24.22.1 bundles ICU 78.3 (`process.versions.icu`). */
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

/** The data categories the runtime pack's copy of icudt78l.dat leaves out:
 * item-name prefixes under `icudt78l/` (a trailing `/` names a tree) and
 * `*.cnv` for the charset converters. scr_intl.c answers its Intl forms with
 * ICU's break iterators, number and date formatters, calendars and locale
 * IDs, which read the locale data, `brkitr/`, `curr/`, `unit/` (the unit
 * style of Intl.NumberFormat), `zone/` (the timeZoneName option of
 * Intl.DateTimeFormat) and `region/` (the generic zone names that are a
 * country's, "United Kingdom Time") and never these: converters,
 * collation, display names of languages, spell-out rules and
 * transliterators. An Intl form that needs one of them removes it from this
 * list and updates the two pins below in the same change.
 * tests/harness/icu-data-filter.test.ts runs every `@requires-icu` corpus
 * program with the pack's file and with the full one and fails when their
 * outputs differ. */
export const ICU_DATA_DROPPED = ["*.cnv", "coll/", "lang/", "rbnf/", "translit/"];
/** icudt78l.dat without the ICU_DATA_DROPPED items (icu-data.mjs, filterIcuData). */
export const ICU_PACK_DATA_SHA256 =
  "0a8eee0ff6089533112dc0c04756303e5ba019286e0e0c2284e4b5a1418826cc";
export const ICU_PACK_DATA_SIZE = 19_606_096;
