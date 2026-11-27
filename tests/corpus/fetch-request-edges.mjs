// Request edge semantics: the invalid redirect member throws undici's
// enum-converter TypeError with Node's exact message, and `new Request(src)`
// transfers the source's body — the source is used at once (its readers and
// clone() refuse), the copy reads the body, and a second copy of the source
// is refused.
const outcome = async (fn) => {
  try {
    return String(await fn());
  } catch (caught) {
    return `${caught.constructor.name} ${caught.code ?? "nocode"} ${caught.message}`;
  }
};
console.log("redirect manual", new Request("https://example.com/", { redirect: "manual" }).redirect);
console.log("redirect error", new Request("https://example.com/", { redirect: "error" }).redirect);
console.log(
  "redirect bogus",
  await outcome(() => new Request("https://example.com/", { redirect: "bogus" })),
);
console.log(
  "redirect number",
  await outcome(() => new Request("https://example.com/", { redirect: 5 })),
);

const source = new Request("https://example.com/", { method: "POST", body: "abc" });
const copy = new Request(source);
console.log("copy", copy.method, copy.bodyUsed, source.bodyUsed);
console.log("source text", await outcome(() => source.text()));
console.log("copy text", JSON.stringify(await copy.text()), copy.bodyUsed);
console.log("source clone", await outcome(() => source.clone()));
console.log("second copy", await outcome(() => new Request(source)));

const used = new Request("https://example.com/", { method: "POST", body: "xyz" });
await used.text();
console.log("used copy", await outcome(() => new Request(used)));
console.log("used bodyUsed", used.bodyUsed);

// A construction that throws leaves the source usable: Node marks the source
// only once the new Request exists.
const unmarked = new Request("https://example.com/", { method: "POST", body: "keep" });
console.log(
  "failed redirect",
  await outcome(() => new Request(unmarked, { redirect: "bogus" })),
  unmarked.bodyUsed,
);
console.log(
  "failed method",
  await outcome(() => new Request(unmarked, { method: "GET" })),
  unmarked.bodyUsed,
);
console.log("kept copy", JSON.stringify(await new Request(unmarked).text()));
