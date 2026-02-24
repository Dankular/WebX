cmake_minimum_required(VERSION 3.20)
project(vkwebx C)

set(CMAKE_C_STANDARD 11)

# Must be cross-compiled for x86-64 Linux to run inside CheerpX.
# Example toolchain file: cmake/x86_64-linux-gnu.cmake
# Usage:
#   cmake -B build -DCMAKE_TOOLCHAIN_FILE=../cmake/x86_64-linux-gnu.cmake .
#   cmake --build build

find_package(Vulkan REQUIRED)

add_library(vkwebx SHARED
    src/vkwebx.c
    src/vkwebx_resources.c
    src/vkwebx_pipeline.c
    src/vkwebx_surface.c
)

target_include_directories(vkwebx PRIVATE
    ${Vulkan_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/../protocol
)

target_compile_options(vkwebx PRIVATE
    -Wall -Wextra
    -fvisibility=hidden    # only ICD entry points exported
)

# Export only the three ICD loader symbols
# Use LINK_OPTIONS (not LINK_FLAGS) so CMake properly quotes paths with spaces.
set_target_properties(vkwebx PROPERTIES
    C_VISIBILITY_PRESET hidden
)
target_link_options(vkwebx PRIVATE
    "LINKER:--version-script,${CMAKE_SOURCE_DIR}/vkwebx.map"
)

target_link_libraries(vkwebx PRIVATE pthread)

install(TARGETS vkwebx LIBRARY DESTINATION /usr/local/lib)
install(FILES vkwebx_icd.json DESTINATION /etc/vulkan/icd.d)

# ── libxcb_stub.so — fake XCB for DXVK/Wine (LD_PRELOAD) ──────────────────
#
# Stubs all xcb_* functions so DXVK and Wine can create "windows" without a
# real X server running.  The vkwebx ICD ignores the xcb connection/window
# pointers entirely, so fake handles are sufficient.
#
add_library(xcb_stub SHARED src/xcb_stub.c)
set_target_properties(xcb_stub PROPERTIES
    OUTPUT_NAME "xcb_stub"
    C_VISIBILITY_PRESET default   # all symbols must be visible for LD_PRELOAD
)
target_compile_options(xcb_stub PRIVATE -Wall -Wextra)
install(TARGETS xcb_stub LIBRARY DESTINATION /usr/local/lib)
