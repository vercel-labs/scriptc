// String(), template literals and concatenation over a `string | URL`
// union: the string arm passes through and the URL arm converts through its
// href, exactly as each would alone (an origin URL keeps its trailing
// slash, the origin string does not).
function key(origin: string | URL): string {
  return String(origin);
}

function label(origin: string | URL | undefined): string {
  return `[${origin}]`;
}

const url = new URL("http://127.0.0.1:8080");
console.log(key("http://127.0.0.1:8080"));
console.log(key(url));
console.log(key(new URL("https://example.com/a/b?x=1#h")));
console.log(label(url), label("plain"), label(undefined));
const both: (string | URL)[] = ["a", url];
console.log(both.map((o) => "" + o).join(" "));
const map = new Map<string, number>();
map.set(key(url.origin), 1);
console.log(map.get(String(url.origin)), map.get(String(url)));
