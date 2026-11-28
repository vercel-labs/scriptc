// new Intl.Locale is part of Node's internationalization API but has no
// native lowering: constructing it refuses with SC2020, which the program API
// reports as a DualRunBuildError.
const locale = new Intl.Locale("en-US");
console.log(locale.toString());
