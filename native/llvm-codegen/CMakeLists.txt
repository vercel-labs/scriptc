cmake_minimum_required(VERSION 3.24)

set(SCRIPTC_PACKAGE_VERSION "0.0.0-dev" CACHE STRING
    "scriptc npm package version reported by the helper protocol")
set(SCRIPTC_DEFAULT_TARGET "arm64-apple-macosx14.0.0" CACHE STRING
    "Default target reported by the helper protocol")
set(SCRIPTC_DEFAULT_DATA_LAYOUT
    "e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-n32:64-S128-Fn32"
    CACHE STRING "Data layout for SCRIPTC_DEFAULT_TARGET")
set(SCRIPTC_TARGET_BACKENDS "AArch64" CACHE STRING
    "Semicolon-separated LLVM target backends compiled into the helper")
set(SCRIPTC_ALLOWED_TARGETS "arm64-apple-macosx14.0.0" CACHE STRING
    "Comma-separated target triples accepted by this helper")
set(SCRIPTC_HELPER_ARCH "arm64" CACHE STRING
    "macOS architecture of the helper executable")

# These must be cache variables before project() enables the Apple toolchain.
# A target property named OSX_DEPLOYMENT_TARGET is not recognized by CMake and
# silently leaves the executable at the build host/SDK's deployment version.
if(APPLE)
  set(CMAKE_OSX_ARCHITECTURES "${SCRIPTC_HELPER_ARCH}" CACHE STRING
      "Architectures for the macOS helper" FORCE)
  # Homebrew's pinned LLVM 22 bottle is built for macOS 15. The helper must
  # tell the truth about that host requirement; the objects it emits retain
  # their separate arm64-apple-macosx14.0.0 deployment target.
  set(CMAKE_OSX_DEPLOYMENT_TARGET "15.0" CACHE STRING
      "Minimum macOS version for the packaged helper" FORCE)
endif()

project(scriptc_llvm_codegen LANGUAGES C CXX)

# Official LLVM binary distributions retain zstd as an imported dependency in
# LLVMSupport. Resolve it before loading LLVM's exported targets so CMake never
# leaves an unresolved `zstd::libzstd_static` edge on Linux or Windows.
find_package(zstd CONFIG QUIET)

find_package(LLVM 22.1.8 EXACT REQUIRED CONFIG)

# LLVM's exported Support target names zstd's shared target even when the
# selected LLVM components are static. The npm sidecar must not retain a
# Homebrew zstd dylib dependency.
if(TARGET zstd::libzstd_shared AND TARGET zstd::libzstd_static)
  get_target_property(SCRIPTC_ZSTD_STATIC zstd::libzstd_static IMPORTED_LOCATION_RELEASE)
  if(NOT SCRIPTC_ZSTD_STATIC)
    get_target_property(SCRIPTC_ZSTD_STATIC zstd::libzstd_static IMPORTED_LOCATION)
  endif()
  if(SCRIPTC_ZSTD_STATIC)
    set_target_properties(zstd::libzstd_shared PROPERTIES
      IMPORTED_LOCATION "${SCRIPTC_ZSTD_STATIC}"
      IMPORTED_LOCATION_RELEASE "${SCRIPTC_ZSTD_STATIC}"
    )
  endif()
endif()

add_executable(scriptc-llvm-codegen
  src/diagnostics.cpp
  src/emit.cpp
  src/main.cpp
  src/target.cpp
)

target_compile_features(scriptc-llvm-codegen PRIVATE cxx_std_17)
target_include_directories(scriptc-llvm-codegen PRIVATE ${LLVM_INCLUDE_DIRS})
target_compile_definitions(scriptc-llvm-codegen PRIVATE
  ${LLVM_DEFINITIONS}
  SCRIPTC_PACKAGE_VERSION="${SCRIPTC_PACKAGE_VERSION}"
)
# The official Linux and Windows LLVM archives are commonly built with RTTI
# disabled. Mixing RTTI modes turns otherwise ordinary virtual typeinfo into
# an unresolved link symbol when the helper links those static components.
if(NOT LLVM_ENABLE_RTTI)
  if(MSVC)
    target_compile_options(scriptc-llvm-codegen PRIVATE /GR-)
  else()
    target_compile_options(scriptc-llvm-codegen PRIVATE -fno-rtti)
  endif()
endif()

foreach(SCRIPTC_TARGET_BACKEND IN LISTS SCRIPTC_TARGET_BACKENDS)
  if(SCRIPTC_TARGET_BACKEND STREQUAL "AArch64")
    list(APPEND SCRIPTC_LLVM_TARGET_LIBS AArch64CodeGen)
    target_compile_definitions(scriptc-llvm-codegen PRIVATE SCRIPTC_ENABLE_AARCH64=1)
  elseif(SCRIPTC_TARGET_BACKEND STREQUAL "X86")
    list(APPEND SCRIPTC_LLVM_TARGET_LIBS X86CodeGen)
    target_compile_definitions(scriptc-llvm-codegen PRIVATE SCRIPTC_ENABLE_X86=1)
  elseif(SCRIPTC_TARGET_BACKEND STREQUAL "WebAssembly")
    list(APPEND SCRIPTC_LLVM_TARGET_LIBS WebAssemblyCodeGen)
    target_compile_definitions(scriptc-llvm-codegen PRIVATE SCRIPTC_ENABLE_WEBASSEMBLY=1)
  else()
    message(FATAL_ERROR "unsupported SCRIPTC_TARGET_BACKENDS entry: ${SCRIPTC_TARGET_BACKEND}")
  endif()
endforeach()

# The WebAssembly target machine emits either an object or final wasm module,
# but LLVM's normal `CodeGen` component remains the shared driver interface.
# Keep the backend list canonical in the protocol rather than relying on the
# host's installed LLVM target registry.

string(REPLACE ";" "," SCRIPTC_TARGET_BACKENDS_JSON "${SCRIPTC_TARGET_BACKENDS}")
target_compile_definitions(scriptc-llvm-codegen PRIVATE
  SCRIPTC_DEFAULT_TARGET="${SCRIPTC_DEFAULT_TARGET}"
  SCRIPTC_DEFAULT_DATA_LAYOUT="${SCRIPTC_DEFAULT_DATA_LAYOUT}"
  SCRIPTC_TARGET_BACKENDS="${SCRIPTC_TARGET_BACKENDS_JSON}"
  SCRIPTC_ALLOWED_TARGETS="${SCRIPTC_ALLOWED_TARGETS}"
)

llvm_map_components_to_libnames(SCRIPTC_LLVM_LIBS
  ${SCRIPTC_LLVM_TARGET_LIBS}
  CodeGen
  Core
  Coroutines
  IRReader
  Passes
  Support
  Target
)
target_link_libraries(scriptc-llvm-codegen PRIVATE ${SCRIPTC_LLVM_LIBS})

if(APPLE)
  # Homebrew's static LLVM archives contain broad component object files.
  # Export only the process entry point so archive-global LLVM symbols do not
  # become roots, then discard functions/data the small helper protocol cannot
  # reach. This also keeps the result stable across LLVM bottle layouts whose
  # static archives expose different sets of global symbols.
  target_link_options(scriptc-llvm-codegen PRIVATE
    "LINKER:-exported_symbol,_main"
    "LINKER:-dead_strip"
    # Homebrew's unversioned LLVM 22 bottle adds Z3 as an unconditional
    # transitive dylib even though this helper never reaches the solver. Drop
    # unused dylibs so the npm sidecar remains runnable without Homebrew.
    "LINKER:-dead_strip_dylibs"
  )
endif()
