// Empty array literals whose own type is `never[]`: `return []` in an async
// function (its contextual type is `string[] | PromiseLike<string[]>`) and
// an object literal's `files: []` field returned or passed where typed
// arrays are declared. Each value holds the declared element type.
interface Listing {
  files: string[];
  sizes: number[];
}

async function readNames(text: string): Promise<string[]> {
  try {
    return JSON.parse(text) as string[];
  } catch {
    return [];
  }
}

const loadIds = async (fail: boolean): Promise<number[]> => {
  if (fail) return [];
  return [1, 2];
};

function emptyListing(): Listing {
  const listing = { files: [], sizes: [] };
  return listing;
}

function index(): Record<"files" | "dirs", string[]> {
  const out = { files: [], dirs: [] };
  return out;
}

function total(listing: Listing): number {
  return listing.sizes.reduce((sum, size) => sum + size, 0);
}

async function main(): Promise<void> {
  const names = await readNames("not json");
  names.push("fallback");
  console.log(names, (await readNames('["a","b"]')).join("+"));
  const ids = await loadIds(true);
  ids.push(7);
  console.log(ids, await loadIds(false));

  const listing = emptyListing();
  listing.files.push("a.txt");
  listing.sizes.push(3, 4);
  console.log(listing, total(listing));

  const dirs = index();
  dirs.dirs.push("src");
  console.log(JSON.stringify(dirs), dirs.files.length);

  const blank = { files: [], sizes: [] };
  console.log(total(blank), JSON.stringify(blank));
}

main();
