// The symbol classifier the zero-cost gate uses to prove that a program which
// does not use Intl links no part of the ICU archive. The samples
// are the shapes `nm` printed for the archive-linked binaries: ICU's C API
// with its `_78` version suffix, its data symbol, and the several Itanium
// manglings of names in namespace icu_78 — own namespace, parameters only,
// internal linkage, guard variables, vtables and typeinfo.
import { describe, expect, it } from "vitest";

import { icuSymbols } from "../../scripts/zero-cost-compare.mjs";

const ICU_SYMBOLS = [
  "ubrk_open_78",
  "unum_open_78",
  "u_strToUTF8_78",
  "icudt78_dat",
  "_ZN6icu_7813UnicodeString6appendEPKDsi",
  "_ZNK6icu_7824DateTimePatternGenerator17getDateTimeFormatE16UDateFormatStyleR10UErrorCode",
  "_Z24ulocimp_toLanguageTag_78PKcRN6icu_788ByteSinkEbR10UErrorCode",
  "_ZL10createPathPKciS0_iS0_RN6icu_7810CharStringEP10UErrorCode",
  "_ZGVZN6icu_7823IslamicUmalquraCalendar19handleComputeFieldsEiR10UErrorCodeE14kUmalquraStart",
  "_ZTWN6icu_7810CharStringE",
  "_ZTVN6icu_7813UnicodeStringE",
  "_ZTIN6icu_7813UnicodeStringE",
  "_ZTSN6icu_7813UnicodeStringE",
  // A libc++ instantiation over an ICU type exists only inside the archive.
  "_ZNSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE6appendERN6icu_7810CharStringE",
];

// The engine-free Intl paths share the `scr_intl_` prefix and must stay
// linkable without ICU (grapheme segmentation, the en-US number fast path),
// so the classifier does not key on it.
const NON_ICU_SYMBOLS = [
  "main",
  "scr_intl_num_format_en_us",
  "scr_intl_segmenter_new",
  "scr_intl_segmenter_refusing",
  "scr_dyn_call",
  "scr_string_concat",
  // Emitted program functions are numbered, and a number can be 78.
  "sc_f__x25_dyn_class_property_78",
  "sc_bf__x25_arr_loop_78",
];

describe("icuSymbols", () => {
  it("classifies every ICU archive symbol", () => {
    expect(icuSymbols(ICU_SYMBOLS)).toEqual([...ICU_SYMBOLS].sort());
  });

  it("leaves the engine-free runtime alone", () => {
    expect(icuSymbols(NON_ICU_SYMBOLS)).toEqual([]);
  });

  it("deduplicates and sorts", () => {
    expect(icuSymbols(["ubrk_close_78", "main", "ubrk_close_78", "icudt78_dat"])).toEqual([
      "icudt78_dat",
      "ubrk_close_78",
    ]);
  });
});
