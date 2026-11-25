// A bare read of a Node 24 global the project declares ambiently (the
// @types/node shape) answers Node's constructor, which refuses construction:
// native code can never produce the instance (SC2020, host-global).
declare var FormData: { new (): unknown };
const form = new FormData();
console.log(form);
