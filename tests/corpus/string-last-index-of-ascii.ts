// lastIndexOf on ASCII receivers: every position form, empty and long
// needles, needles with non-ASCII text, and receivers built at run time.
const ids = ["bk_00042", "mb_00410", "plain", "_lead", "trail_", "a_b_c_d", ""];
for (const id of ids) console.log(JSON.stringify(id), id.lastIndexOf("_"), Number(id.slice(id.lastIndexOf("_") + 1)));

const text = "abcabcabc";
const positions = [Infinity, -Infinity, NaN, -0, 0, 1, 2.9, 3, 5, 8, 9, 100, -5];
for (const needle of ["abc", "c", "a", "", "abcabcabcabc", "cab", "x", "é", "\ud83d", "😀"]) {
  const row = positions.map((position) => text.lastIndexOf(needle, position));
  console.log(JSON.stringify(needle), text.lastIndexOf(needle), row.join(","));
}

// Receivers built at run time (concatenation, repeat, join, slices).
const built = ["x", "y"].join("-").repeat(3) + String(42);
console.log(built, built.lastIndexOf("-"), built.lastIndexOf("x-", 3), built.lastIndexOf("42", 6));
const slice = built.slice(2, 9);
console.log(slice, slice.lastIndexOf("y"), slice.lastIndexOf("y", 0), slice.lastIndexOf("-y-"));

// A non-ASCII receiver keeps UTF-16 positions.
const mixed = "é_ü_😀_z";
console.log(mixed.lastIndexOf("_"), mixed.lastIndexOf("_", 3), mixed.lastIndexOf("😀"), mixed.lastIndexOf("\ude00"));
