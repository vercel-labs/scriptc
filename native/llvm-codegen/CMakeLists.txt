cmake_minimum_required(VERSION 3.24)

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
  AArch64
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
  set_target_properties(scriptc-llvm-codegen PROPERTIES
    OSX_ARCHITECTURES arm64
    OSX_DEPLOYMENT_TARGET 14.0
  )
endif()
