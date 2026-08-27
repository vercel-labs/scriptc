cmake_minimum_required(VERSION 3.24)

# These must be cache variables before project() enables the Apple toolchain.
# A target property named OSX_DEPLOYMENT_TARGET is not recognized by CMake and
# silently leaves the executable at the build host/SDK's deployment version.
if(CMAKE_HOST_APPLE)
  set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING
      "Architectures for the macOS helper" FORCE)
  # Homebrew's pinned LLVM 22 bottle is built for macOS 15. The helper must
  # tell the truth about that host requirement; the objects it emits retain
  # their separate arm64-apple-macosx14.0.0 deployment target.
  set(CMAKE_OSX_DEPLOYMENT_TARGET "15.0" CACHE STRING
      "Minimum macOS version for the packaged helper" FORCE)
endif()

project(scriptc_llvm_codegen LANGUAGES C CXX)

find_package(LLVM 22.1.8 EXACT REQUIRED CONFIG)

set(SCRIPTC_PACKAGE_VERSION "0.0.0-dev" CACHE STRING
    "scriptc npm package version reported by the helper protocol")

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

llvm_map_components_to_libnames(SCRIPTC_LLVM_LIBS
  AArch64CodeGen
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
