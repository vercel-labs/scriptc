// `replace` and `replaceAll` with a one-character search value: no match,
// matches at both ends, removal, `$` patterns, non-ASCII text and search
// values, an empty search value and one longer than the text. Then chains of
// one-character replacements in both spellings (`replaceAll("&", …)` and
// `replace(/&/g, …)`) and mixed, and the chains that must stay steps: a
// later step that replaces what an earlier one wrote, a repeated character,
// `$` patterns, a first-occurrence step, and search values that are not one
// ASCII character.

const TEXTS: string[] = [
  "",
  "a",
  "<",
  "line one\n\ttwo && <three> ab\n",
  "plain text without markup 0123456789",
  'a <b class="x"> & \'c\' > d',
  "&&&&<<<<>>>>\"\"\"\"''''",
  "café <ü> & 中文",
  "pair \u{1F600} & lone \ud83d < end \ude00",
  "x".repeat(70) + "&" + "y".repeat(70) + "<",
];

function escapeChain(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function escapeSteps(s: string): string {
  let t = s.replaceAll("&", "&amp;");
  t = t.replaceAll("<", "&lt;");
  t = t.replaceAll(">", "&gt;");
  return t;
}

function chainForms(s: string): string[] {
  return [
    // The same steps spelled with one-character regexes, and a mix.
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    s.replace(/&/g, "&amp;").replaceAll("<", "&lt;").replaceAll(`>`, "&gt;"),
    // A later step replaces a character an earlier step wrote.
    s.replaceAll("<", "&lt;").replaceAll("&", "&amp;"),
    s.replaceAll("a", "b").replaceAll("b", "a"),
    // A step writes the search value of the step after it and of the one
    // before it.
    s.replaceAll("a", "<b>").replaceAll("<", "[a]").replaceAll("b", "<"),
    s.replace(/&/g, "<").replace(/</g, ">").replace(/>/g, "&"),
    // The same character twice, `$` patterns, a first-occurrence step.
    s.replaceAll("&", "<").replaceAll("&", ">"),
    s.replaceAll("&", "[$&]").replaceAll("<", "[$$]"),
    s.replaceAll("&", "+").replace("<", "-").replaceAll(">", "="),
    // Control characters and a removal.
    s.replaceAll("\n", "<br>").replaceAll("\t", "    ").replaceAll(" ", ""),
    // Not one ASCII character: a non-ASCII one, two, none.
    s.replaceAll("é", "e").replaceAll("<", "("),
    s.replaceAll("&&", "&").replaceAll("<", "("),
    s.replaceAll("", ".").replaceAll("<", "("),
  ];
}

function replaceCells(s: string, search: string): void {
  const texts = ["-", "", "<<>>", "[$&]", "[$$]", "[$1]", "[$`|$']", "é", "\ude00"];
  for (const text of texts) {
    console.log(
      JSON.stringify(search),
      JSON.stringify(text),
      JSON.stringify(s.replace(search, text)),
      JSON.stringify(s.replaceAll(search, text)),
    );
  }
}

for (const s of TEXTS) {
  console.log(JSON.stringify(s));
  console.log(" chain", JSON.stringify(escapeChain(s)), JSON.stringify(escapeSteps(s)));
  console.log(" forms", JSON.stringify(chainForms(s)));
  console.log(" same", s.replaceAll("\u0001", "x") === s, s.replace("\u0001", "x") === s);
}

replaceCells('a.b.c..d "." e', ".");
replaceCells("....", ".");
replaceCells("", ".");
replaceCells("café.ü.\u{1F600}", ".");
replaceCells("café.ü.\u{1F600}", "é");
replaceCells("hi \ud83d. \ud83d", ".");
replaceCells("aaaa", "aa");
replaceCells("abc", "");
replaceCells("ab", "abc");
replaceCells("a$b$$c", "$");
