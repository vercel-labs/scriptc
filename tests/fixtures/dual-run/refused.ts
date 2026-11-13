// MessageChannel has no scriptc lowering yet: the build refuses with SC2020,
// which the program API reports as a DualRunBuildError.
const channel = new MessageChannel();
console.log(channel.port1);
