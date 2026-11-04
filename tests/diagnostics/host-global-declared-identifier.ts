// A bare read of a Node 24 global the project declares ambiently (the
// @types/node shape): Node has the constructor, native code does not
// (SC2020, host-global).
declare var FormData: { new (): unknown };
const ctor = FormData;
console.log(typeof ctor);
