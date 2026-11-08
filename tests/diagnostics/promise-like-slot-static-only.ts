// A slot declared with the library's PromiseLike holds whatever has a `then`
// method, a promise or an object of the program, as a checked-dynamic value.
// Under --tier=static-only there is no such slot, so the declaration is
// refused by name, with the type that keeps the slot static.
function settle(work: PromiseLike<number>): Promise<number> {
  return Promise.resolve(work);
}

console.log(typeof settle);
