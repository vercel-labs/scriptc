// An application class that happens to hold a DOM class's name. Its
// `.constructor` read is a real comparison, not the DOM global's class.
export class Event {
  kind = "app";
}

/** A factory that validates before it answers (and can reject). */
export function validate(): Event {
  console.log("validate");
  throw new Error("rejected");
}
