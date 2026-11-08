// A generic function reads a member whose name is a template built from its
// type parameter, on a mapped type over that template beside other members.
// A call that passes a literal compiles: its record lists the member the
// literal names (tests/corpus/9565-generic-template-key-read.ts). This call
// passes a plain string, so the instance's record has no member the key
// could name while the object does hold one; the read is refused by name
// instead of answering undefined (tests/harness/generic-template-key.test.ts).
interface Labels<Lang extends string> {
  lang: Lang;
  words: { [K in `word-${Lang}`]?: string } & { plural?: string; short?: string };
}

function word<Lang extends string>({ lang, words }: Labels<Lang>): string {
  const found = words[`word-${lang}` as const];
  return typeof found === "string" ? found : "missing";
}

const langs: string[] = ["en", "de"];
for (const lang of langs) console.log(word({ lang, words: { [`word-${lang}`]: "w-" + lang } }));
