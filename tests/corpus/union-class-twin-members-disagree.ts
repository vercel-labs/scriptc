// Two unions each have members that share a discriminant literal, and one member is written in
// both. Their other members declare `owner` with two types, so no one record holds the members of
// both unions: each member keeps its own layout, the twin's is the same in both unions, and a
// value of it is the same object in both.
type Plot = { kind: "land"; name: string };
type Farm = { kind: "land"; name: string; owner: string };
type Lake = { kind: "water"; depth: number };
type Parcel = Plot | Farm | Lake;
type Lot = { kind: "land"; name: string };
type Share = { kind: "land"; name: string; owner: number };
type Road = { kind: "way"; lanes: number };
type Asset = Lot | Share | Road;

function parcel(p: Parcel): string {
  if (p.kind === "water") return "lake " + p.depth;
  return "owner" in p ? "farm " + p.name + " of " + p.owner : "plot " + p.name;
}
function asset(a: Asset): string {
  if (a.kind === "way") return "road " + a.lanes;
  return "owner" in a ? "share " + a.name + " #" + (a.owner + 1) : "lot " + a.name;
}

const meadow: Plot = { kind: "land", name: "meadow" };
const asParcel: Parcel = meadow;
const asAsset: Asset = meadow;
console.log(asParcel === meadow, asAsset === meadow, parcel(asParcel), asset(asAsset));
if (asAsset.kind === "land") asAsset.name = "meadow, surveyed";
console.log(meadow.name, JSON.stringify(asParcel), Object.keys(asAsset).join(","));

const farm: Farm = { kind: "land", name: "farm", owner: "ida" };
const share: Share = { kind: "land", name: "share", owner: 6 };
const parcels: Parcel[] = [farm, meadow, { kind: "water", depth: 4 }];
const assets: Asset[] = [share, meadow, { kind: "way", lanes: 2 }];
console.log(parcels.map(parcel).join("; "));
console.log(assets.map(asset).join("; "));
console.log(parcels[0] === farm, assets[0] === share, parcels[1] === meadow, assets[1] === meadow);
farm.owner = "joan";
share.owner = 7;
console.log(JSON.stringify(parcels), JSON.stringify(assets));
