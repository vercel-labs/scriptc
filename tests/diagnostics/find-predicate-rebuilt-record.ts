// `.find` and `.findLast` answer the element itself: the value they return
// is the object the array holds, so comparing it with the array's element,
// keying a Map by it or writing through it reaches that one object. A
// written type predicate converts the answered element with a check, and a
// conversion that would build another record has no place here. This array
// holds its elements as parcels with a label; a weighed parcel stored in it
// is held in that narrower layout, and reading it back as a weighed parcel
// rebuilds it. `.filter` may do that for the new array it answers; a search
// may not, so these stay refused. Declaring the array's element type as
// `Parcel | WeighedParcel` keeps each element as it was stored.
interface Parcel {
  label: string;
}
interface WeighedParcel extends Parcel {
  grams: number;
}

const books: WeighedParcel = { label: "books", grams: 900 };
const parcels: Parcel[] = [{ label: "letters" }, books];

const weighed = parcels.find((parcel): parcel is WeighedParcel => "grams" in parcel);
console.log(weighed?.grams);

function isWeighed(parcel: Parcel): parcel is WeighedParcel {
  return "grams" in parcel;
}
// The same search with a guard function passed by name, from the end.
console.log(parcels.findLast(isWeighed)?.label);
