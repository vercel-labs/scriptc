// Rest copies over one index-signature shape intern a %rec.rest helper per
// (source shape, rest shape, consumed set). A property name may itself hold a
// comma, so the sets `{"a,b"}` and `{"a", "b"}` must not intern one helper:
// each copy has to skip exactly the keys its own pattern consumed.
type Bag = { [key: string]: number };

function report(tag: string, obj: Bag): void {
  console.log(tag, JSON.stringify(Object.keys(obj)));
}

const bag: Bag = { a: 1, b: 2, "a,b": 3, "": 4 };

const { "a,b": commaKey, ...restComma } = bag;
const { a, b, ...restPlain } = bag;

console.log("comma key:", commaKey);
report("comma rest:", restComma);
report("plain rest:", restPlain);

// The empty name joins to nothing, so the set holding it alone and the empty
// set are a second tie of the same kind.
const { "": emptyKey, ...restNoEmpty } = bag;
report("empty-named rest:", restNoEmpty);
report("consumed empty name:", { "": emptyKey } as Bag);
const { ...restAll } = bag;
report("whole rest:", restAll);
