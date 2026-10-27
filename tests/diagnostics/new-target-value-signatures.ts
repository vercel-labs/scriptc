// new.target as a class value needs every subclass to construct with the
// base's signature; B's constructor takes a parameter A's does not.
class A { readonly t: typeof A; constructor() { this.t = new.target; } }
class B extends A { constructor(readonly n: number) { super(); } }
console.log(new B(1).t.name);
