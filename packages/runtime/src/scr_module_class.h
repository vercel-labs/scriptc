/* node:module's Module class value and prototype (scr_module_class.c). Both
 * answer +1. Declared here so a linked program's calls resolve through the
 * runtime headers the LLVM ABI check reads. */
#ifndef SCR_MODULE_CLASS_H
#define SCR_MODULE_CLASS_H

#include "scr_dyn.h"

ScrDyn *scr_module_class_value(void);
ScrDyn *scr_module_class_prototype(void);

#endif
