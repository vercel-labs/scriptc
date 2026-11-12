// WeakRef has no scriptc lowering yet: the build refuses with SC2020, which
// the program API reports as a DualRunBuildError.
const reference = new WeakRef({ value: 1 });
console.log(reference.deref()?.value);
