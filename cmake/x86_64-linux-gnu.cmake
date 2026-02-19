# Cross-compilation toolchain: x86-64 Linux
# Used to build guest-icd/ for deployment inside CheerpX's emulated Linux.
#
# Install toolchain: apt install gcc-x86-64-linux-gnu

set(CMAKE_SYSTEM_NAME      Linux)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

set(CMAKE_C_COMPILER   x86_64-linux-gnu-gcc)
set(CMAKE_CXX_COMPILER x86_64-linux-gnu-g++)

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
