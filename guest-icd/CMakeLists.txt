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
set_target_properties(vkwebx PROPERTIES
    C_VISIBILITY_PRESET hidden
    LINK_FLAGS "-Wl,--version-script=${CMAKE_SOURCE_DIR}/vkwebx.map"
)

target_link_libraries(vkwebx PRIVATE pthread)

install(TARGETS vkwebx LIBRARY DESTINATION /usr/local/lib)
install(FILES vkwebx_icd.json DESTINATION /etc/vulkan/icd.d)
