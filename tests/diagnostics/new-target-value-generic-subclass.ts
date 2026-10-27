// new.target as a class value where a subclass is generic: its
// instantiations have no common class value.
class A { readonly t: typeof A; constructor() { this.t = new.target; } }
class B<T> extends A { readonly v: T | undefined = undefined; }
console.log(new B<number>().t.name);
