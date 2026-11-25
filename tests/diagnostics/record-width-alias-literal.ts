// A literal storing an existing value in a declared field the field's type
// would copy: a write through the literal's field would reach only the
// copy, while under Node it reaches the stored object.
type Inner = { a: number };
type WideInner = { a: number; b: number };

const wide: WideInner = { a: 1, b: 2 };
const holder: { inner: Inner } = { inner: wide };
holder.inner.a = 5;
console.log(wide.a);
