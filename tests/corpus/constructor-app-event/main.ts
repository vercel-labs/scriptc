// The DOM global `Event` beside an application class named Event: the
// comparison must evaluate the factory's call (its validation and throw),
// and must not fold the app class against the DOM global.
import { validate } from "./factory.ts";

try {
  console.log(validate().constructor === Event, Event.name);
} catch (error) {
  console.log("caught", (error as Error).message, Event.name);
}
