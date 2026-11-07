// The value type of a dictionary compared by structure: readonly members,
// intersections, arrays, functions, unions and recursive types spelled twice
// are one value type, so the dictionary is one object under both spellings.
function show(same: boolean, held: object, source: object, value: unknown): void {
  console.log(same, Object.keys(held).join(","), Object.keys(source).join(","), JSON.stringify(value));
}

// A readonly member is the same member.
const memberSource = { first: { member: 1 } };
const memberHeld: { [key: string]: { member: number } } = memberSource;
memberHeld.second = { member: 2 };
const memberAgain: { [key: string]: { readonly member: number } } = memberHeld;
memberAgain.third = { member: 3 };
show(memberAgain === memberHeld, memberHeld, memberSource, memberAgain);

// Readonly<> of the dictionary and a readonly index signature: the write
// goes through the first name and is read through the others.
const frozenSource = { first: { frozen: 1 } };
const frozenHeld: { [key: string]: { frozen: number } } = frozenSource;
frozenHeld.second = { frozen: 2 };
const frozenView: Readonly<{ [key: string]: { frozen: number } }> = frozenHeld;
const frozenSignature: { readonly [key: string]: { frozen: number } } = frozenHeld;
frozenHeld.third = { frozen: 3 };
show(frozenView === frozenHeld, frozenView, frozenSource, frozenView);
show(frozenSignature === frozenHeld, frozenSignature, frozenSource, frozenSignature.third?.frozen);

// An intersection as the value type.
const crossSource = { first: { cross: 1 } };
const crossHeld: { [key: string]: { cross: number } & { extra?: string } } = crossSource;
crossHeld.second = { cross: 2, extra: "e" };
const crossAgain: { [key: string]: { cross: number } & { extra?: string } } = crossHeld;
crossAgain.third = { cross: 3 };
show(crossAgain === crossHeld, crossHeld, crossSource, crossAgain);

// The dictionary spelled as an intersection of two index signatures.
const bothSource = { first: { both: 1 } };
const bothHeld: { [key: string]: { both: number } } = bothSource;
bothHeld.second = { both: 2 };
const bothAgain: { [key: string]: { both: number } } & { [other: string]: { both: number } } = bothHeld;
bothAgain.third = { both: 3 };
show(bothAgain === bothHeld, bothHeld, bothSource, bothAgain);

// An array of records.
const listSource = { first: [{ item: 1 }] };
const listHeld: { [key: string]: { item: number }[] } = listSource;
listHeld.second = [{ item: 2 }];
const listAgain: { [key: string]: { item: number }[] } = listHeld;
listAgain.third = [{ item: 3 }, { item: 4 }];
show(listAgain === listHeld, listHeld, listSource, listAgain);

// Functions.
const callSource = { first: (x: number) => x + 1 };
const callHeld: { [key: string]: (x: number) => number } = callSource;
callHeld.second = (x: number) => x * 2;
const callAgain: { [key: string]: (value: number) => number } = callHeld;
callAgain.third = (x: number) => x - 3;
show(callAgain === callHeld, callHeld, callSource, Object.keys(callAgain).map((key) => callAgain[key]!(10)));

// A union of records, its members in another order.
const choiceSource = { first: { left: 1 } };
const choiceHeld: { [key: string]: { left: number } | { right: string } } = choiceSource;
choiceHeld.second = { right: "r" };
const choiceAgain: { [key: string]: { right: string } | { left: number } } = choiceHeld;
choiceAgain.third = { left: 3 };
show(choiceAgain === choiceHeld, choiceHeld, choiceSource, choiceAgain);

// Two recursive interfaces of one structure.
interface LinkA {
  next: { [key: string]: LinkA } | null;
  n: number;
}
interface LinkB {
  next: { [key: string]: LinkB } | null;
  n: number;
}
const linkSource = { first: { next: null, n: 1 } };
const linkHeld: { [key: string]: LinkA } = linkSource;
linkHeld.second = { next: { inner: { next: null, n: 20 } }, n: 2 };
const linkAgain: { [key: string]: LinkB } = linkHeld;
linkAgain.third = { next: null, n: 3 };
show(linkAgain === linkHeld, linkHeld, linkSource, linkAgain);
