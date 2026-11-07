// A get or set accessor written as a member of a property descriptor map
// literal: Object.defineProperties and Object.create read the member's
// value through the accessor, and the compiled map holds plain members, so
// the form is refused at the accessor.
const items: number[] = [1];
const target: Record<string, unknown> = {};
Object.defineProperties(target, {
  plain: { value: 1, enumerable: true },
  get computed() {
    return { value: items, enumerable: true };
  },
});

const created: unknown = Object.create(null, {
  set ignored(_descriptor: PropertyDescriptor) {},
});
console.log(Object.keys(target), created);
