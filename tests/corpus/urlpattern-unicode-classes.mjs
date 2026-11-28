// URLPattern compiles component patterns with the `v` flag, so a custom
// character class reads Unicode property escapes as properties and accepts
// the set syntax, as Node's URLPattern does.
function show(label, run) {
  try {
    console.log(label, JSON.stringify(run()));
  } catch (error) {
    console.log(label, "threw", error.name, error.message);
  }
}

const letters = new URLPattern({ pathname: "/:id([\\p{L}]+)" });
show("letters", () => [
  letters.pathname,
  letters.test("http://h/q"),
  letters.test("http://h/abc"),
  letters.test("http://h/123"),
]);

// Without the flag, `\p` would be the literal letter p and a set string
// such as `\q{abc}` would not parse as a set at all.
const ascii = new URLPattern({ pathname: "/:id([\\q{abc}]+)" });
show("set", () => [
  ascii.test("http://h/abc"),
  ascii.test("http://h/a"),
  ascii.test("http://h/d"),
]);

const consonants = new URLPattern({ pathname: "/:id([\\p{L}&&[^aeiou]]+)" });
show("intersection", () => [
  consonants.test("http://h/bcd"),
  consonants.test("http://h/abc"),
]);
