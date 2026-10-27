// A function-local subclass makes a new class per evaluation, so the
// base constructor's new.target has no static dispatch.
class A { constructor() { console.log(new.target.name); } }
function make() { class Local extends A {} return new Local(); }
make();
