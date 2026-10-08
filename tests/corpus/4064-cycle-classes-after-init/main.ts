// Classes of two cycle members reference each other (construction,
// instanceof, statics) from method bodies that run after both class
// declarations evaluated; a shared default instance is built at load.
import { Shelf, defaultShelf } from "./shelf.ts";
import { Item } from "./item.ts";

const shelf = new Shelf("garage");
shelf.add("rake");
shelf.add("hose");
console.log(shelf.describe());
console.log(defaultShelf.describe());
console.log(new Item("loose", null).placed(), Item.created, Shelf.count);
