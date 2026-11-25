// URL.revokeObjectURL parses its argument as a URL and revokes the id
// between the first and second colon of the pathname: a query or fragment
// on the id, or a different scheme before the colon, still revokes the
// registration; unparsable input, a pathname with no colon or a second
// colon, an added suffix, and a changed id all miss.
import { isDeepStrictEqual } from "node:util";

const uuid = (e: unknown): string => `${(e as Error).name}: ${(e as Error).message}`;
const describe = uuid;

async function alive(label: string, id: string): Promise<void> {
  try {
    const response = await fetch(id);
    console.log(label, response.status, await response.text());
  } catch (e) {
    console.log(label, describe(e));
  }
}

async function main(): Promise<void> {
  const mk = (text: string): string => URL.createObjectURL(new Blob([text]));
  const idOf = (url: string): string => url.slice("blob:nodedata:".length);

  const plain = mk("plain");
  URL.revokeObjectURL(plain);
  await alive("plain", plain);

  const query = mk("query");
  URL.revokeObjectURL(query + "?x=1");
  await alive("query", query);

  const fragment = mk("fragment");
  URL.revokeObjectURL(fragment + "#part");
  await alive("fragment", fragment);

  const padded = mk("padded");
  URL.revokeObjectURL(` \t${padded}  `);
  await alive("padded", padded);

  const urlObject = mk("url-object");
  URL.revokeObjectURL(new URL(urlObject + "?q=1#f"));
  await alive("url-object", urlObject);

  const otherScheme = mk("other-scheme");
  URL.revokeObjectURL("blob:other:" + idOf(otherScheme));
  await alive("other-scheme", otherScheme);

  const specialUrl = mk("special");
  URL.revokeObjectURL("https://example.test/nodedata:" + idOf(specialUrl));
  await alive("special", specialUrl);

  const upper = mk("upper");
  URL.revokeObjectURL(upper.toUpperCase());
  await alive("upper", upper);

  const secondColon = mk("second-colon");
  URL.revokeObjectURL("blob:nodedata:x:" + idOf(secondColon));
  await alive("second-colon", secondColon);

  const suffixed = mk("suffixed");
  URL.revokeObjectURL(suffixed + "x");
  await alive("suffixed", suffixed);

  const noBase = mk("no-base");
  URL.revokeObjectURL("blob:" + idOf(noBase));
  await alive("no-base", noBase);

  const garbage = mk("garbage");
  URL.revokeObjectURL("not a url " + garbage);
  await alive("garbage", garbage);

  const encoded = mk("encoded");
  URL.revokeObjectURL(encoded.replace("blob:", "blob%3A"));
  await alive("encoded", encoded);

  for (const miss of ["", "   ", "blob:only", "blob:", ":x:", "blob::"]) {
    URL.revokeObjectURL(miss);
  }
  console.log("misses", isDeepStrictEqual([plain, query], [plain, query]));
}

await main();
