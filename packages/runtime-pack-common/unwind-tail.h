/* The unwind tail function of a packaged ELF object; scripts/unwind-tail.mjs
 * explains it. Every packaged ELF translation unit includes this file first
 * (-include). The function is empty and nothing references it: it exists so
 * that its entry can end the object's unwind table and carry the table's
 * alignment padding, which would otherwise land on the last real function
 * and change with the sizes of the object's other functions. It has a
 * section of its own, whatever section flags the unit is compiled with, so
 * section garbage collection drops it from every executable.
 *
 * ELF only: the pack build passes this file to ELF targets alone, and the
 * guard keeps a Mach-O or COFF compile that includes it anyway unchanged
 * (a Mach-O section name needs a segment, and neither format has the
 * padding this function absorbs). */
#ifdef __ELF__
__attribute__((used, section(".text.scr_unwind_tail"))) static void scr_unwind_tail(void) {}
#endif
