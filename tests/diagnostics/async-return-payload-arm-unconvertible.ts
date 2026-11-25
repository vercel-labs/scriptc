// A union flowing whole into a record that is one of its arms, where the
// other arm is a value of the record's type for the checker and has no
// conversion into its layout (a Map member whose value type widens). The
// flow is refused where it is written, like that arm's plain flow into the
// record, instead of compiling to a conversion that throws when the value
// arrives.
type Exact = { text: string; index: Map<string, { a: number; b: number }> };
interface Listing {
  text: string;
  index: Map<string, { a: number }>;
}

// then's second type parameter takes Listing from the return context, so the
// call is Promise<Exact | Listing>.
async function fromThen(text: string): Promise<Listing> {
  return Promise.resolve(text).then((t) => ({ text: t, index: new Map([[t, { a: 1, b: 2 }]]) }));
}

const viaArrow = async (text: string): Promise<Listing> =>
  Promise.resolve(text).then((t) => ({ text: t, index: new Map([[t, { a: 1, b: 2 }]]) }));

async function fromAwait(text: string): Promise<Listing> {
  const listing: Listing = await Promise.resolve(text).then((t) => ({
    text: t,
    index: new Map([[t, { a: 1, b: 2 }]]),
  }));
  return listing;
}

function plain(value: Exact | Listing): Listing {
  return value;
}

function narrowedAway(value: Exact | Listing | undefined): Listing {
  if (value === undefined) throw new Error("nothing");
  return value;
}

void fromThen("a");
void viaArrow("a");
void fromAwait("a");
console.log(plain({ text: "a", index: new Map() }).text);
console.log(narrowedAway(undefined).text);
