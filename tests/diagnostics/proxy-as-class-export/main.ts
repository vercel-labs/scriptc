import { Palette, palette, setCurrent } from "./palette.ts";
setCurrent(new Palette("dark"));
console.log(palette.fg("a"));
