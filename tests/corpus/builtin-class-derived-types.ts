// A type derived from a built-in class whose values are opaque handles
// (an interface that extends the class or an Omit or Pick of it, an
// intersection with it, a subset alias, the instance type spelled through
// the constructor) names that class's object. A fetch Response held under
// such a type is the Response itself in every slot: parameters, results,
// fields, elements. Members the derivation keeps or declares again are read
// from the object and checked against the declared type, and an object the
// program makes for a derived type is held like one asserted to the class.
function page(status: number): Response {
  return new Response(JSON.stringify({ variety: "Oxheart", packets: [3, 5] }), {
    status,
    headers: { "x-shelf": "tomato", "content-type": "application/json" },
  });
}

// `extends Omit<...>` with the omitted member declared again, looser.
interface Listing extends Omit<Response, "json"> {
  json(): Promise<any>;
}
// The instance type spelled through the constructor, and the member
// declared again at a record type.
type Native = InstanceType<typeof Response>;
interface Card extends Omit<Native, "json"> {
  json(): Promise<{ variety: string; packets: number[] }>;
}
// Nothing changed, an optional member added, an intersection, two subsets,
// and a derivation of a derivation.
interface Leaf extends Response {}
interface Tagged extends Response {
  shelfmark?: string;
}
type Stamped = Response & { printed?: boolean };
type Brief = Pick<Response, "status" | "ok" | "headers">;
type Quiet = Omit<Response, "json" | "text">;
interface Reprint extends Listing {}

function open(status: number): Promise<Listing> {
  return Promise.resolve(page(status)) as Promise<Listing>;
}
function describe(listing: Listing): string {
  return `${listing.status} ${listing.ok} ${listing.headers.get("x-shelf")}`;
}

// An error class whose constructor takes the derived type.
class OutOfStock extends Error {
  status: number;
  shelf: string | null;
  constructor(message: string, listing: Listing) {
    super(message);
    this.status = listing.status;
    this.shelf = listing.headers.get("x-shelf");
  }
}

async function variety(listing: Listing): Promise<string> {
  if (!listing.ok) throw new OutOfStock("no packets", listing);
  const body = await listing.json();
  return body.variety + " x" + body.packets.length;
}

class Drawer {
  held: Listing | null = null;
  all: Listing[] = [];
  keep(listing: Listing): void {
    this.held = listing;
    this.all.push(listing);
  }
}

const first = await open(200);
console.log(describe(first), await variety(first));
const missing = await open(404);
try {
  await variety(missing);
} catch (e) {
  const known = e instanceof OutOfStock;
  console.log(known, known ? `${e.status} ${e.shelf}` : "", (e as Error).message);
}

// The value is the Response itself wherever it is kept.
const made = page(201);
const drawer = new Drawer();
drawer.keep(made as Listing);
console.log(drawer.held === (made as Listing), drawer.all[0] instanceof Response, drawer.all.length);
console.log(typeof drawer.held, "status" in drawer.all[0]!, Object.keys(drawer.all[0]!).length);
const copy = (made as Listing).clone();
console.log(copy.status, (await copy.text()) === (await made.text()), made.bodyUsed);

// A member declared again at a narrower type is checked where it is read.
const card = page(202) as unknown as Card;
const parsed = await card.json();
console.log(parsed.variety, parsed.packets[1]);

// The other derivations hold the same object; a member a derivation adds
// reads as the object answers it.
const leaf: Leaf = page(203);
const tagged = page(206) as Tagged;
const stamped: Stamped = page(207);
const reprint: Reprint = await open(208);
console.log(leaf.status, tagged.status, tagged.shelfmark, stamped.printed, reprint.status);
function plain(response: Response): number {
  return response.status;
}
function perhaps(listing?: Listing): number {
  return listing?.status ?? -1;
}
console.log(plain(leaf), plain(first), plain(stamped), perhaps(reprint), perhaps());

// Subsets take the built-in object and an object the program makes.
function grade(brief: Brief): string {
  return (brief.ok ? "ok " : "bad ") + brief.status + " " + (brief.headers.get("x-shelf") ?? "-");
}
console.log(grade(page(200)), grade(page(500)));
console.log(grade({ status: 299, ok: true, headers: new Headers({ "x-shelf": "bean" }) }));
const quiet: Quiet = page(209);
console.log(quiet.status, quiet.bodyUsed, (quiet as Response) instanceof Response);

// Other built-in classes of the same kind.
interface Labels extends Omit<Headers, "get"> {
  get(name: string): string | null;
}
interface Order extends Request {}
function shelf(labels: Labels): string {
  return labels.get("x-shelf") + "/" + String(labels.has("x-bin"));
}
function route(order: Order): string {
  return order.method + " " + order.url;
}
console.log(shelf(made.headers as Labels), route(new Request("http://localhost/seeds", { method: "POST" })));
