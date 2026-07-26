cmake_minimum_required(VERSION 3.21)

# vcpkg supplies ffmpeg (and, transitively, what bro's own services need).
# Set before project() so the toolchain file is picked up.
if(NOT DEFINED CMAKE_TOOLCHAIN_FILE AND DEFINED ENV{VCPKG_ROOT})
    set(CMAKE_TOOLCHAIN_FILE "$ENV{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake"
        CACHE STRING "vcpkg toolchain")
endif()

project(ffmpeg-bro VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Where bro lives. A sibling checkout by default, like bro's own multi-repo
# layout; override with -DBRO_DIR=... to point at a release checkout.
set(BRO_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../bro" CACHE PATH "bro engine source")
if(NOT EXISTS "${BRO_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "bro not found at ${BRO_DIR}. Clone it beside this repo or pass -DBRO_DIR=<path>.")
endif()

# bro builds as static libraries; BRO_BUILD_EXECUTABLES defaults OFF when bro
# is not the top-level project, so this does NOT produce a second bro.exe.
add_subdirectory("${BRO_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/bro")

# ── ffmpeg ────────────────────────────────────────────────────────────────
#
# Linking these is what makes this binary GPL. See README.md — it is the
# reason this application lives outside bro's MIT tree.
find_package(FFMPEG REQUIRED)

# The backend + its JS surface, as a library so the app and its tests share
# one build of it.
add_library(ffmpeg-bro-core STATIC
    src/native/ffmpeg_backend.cpp
    src/native/ffmpeg_bindings.cpp
    src/native/ffmpeg_export.cpp
)
target_include_directories(ffmpeg-bro-core
    PUBLIC  "${CMAKE_CURRENT_SOURCE_DIR}/src/native"
    PRIVATE "${BRO_DIR}/src" ${FFMPEG_INCLUDE_DIRS}
)
target_link_libraries(ffmpeg-bro-core PRIVATE bro_video qjs ${FFMPEG_LIBRARIES})
target_link_directories(ffmpeg-bro-core PRIVATE ${FFMPEG_LIBRARY_DIRS})

add_executable(ffmpeg-bro WIN32 src/native/main.cpp)
target_link_libraries(ffmpeg-bro PRIVATE ffmpeg-bro-core bro_engine)
target_include_directories(ffmpeg-bro PRIVATE "${BRO_DIR}/src")

# The same engine and the same backend, driven by a script. This is what the
# UI tests run against, and a usable scripted media tool in its own right.
add_executable(ffmpeg-bro-headless src/native/headless_main.cpp)
target_link_libraries(ffmpeg-bro-headless PRIVATE ffmpeg-bro-core bro_engine)
target_include_directories(ffmpeg-bro-headless PRIVATE "${BRO_DIR}/src")

if(MSVC)
    # Same reason bro.exe needs it: QuickJS's interpreter frame is large and
    # deep JS recursion overflows the default 1 MB stack.
    target_link_options(ffmpeg-bro PRIVATE /STACK:8388608 /ENTRY:mainCRTStartup)
    target_link_options(ffmpeg-bro-headless PRIVATE /STACK:8388608)
endif()
if(WIN32)
    target_link_libraries(ffmpeg-bro PRIVATE ws2_32)
    target_link_libraries(ffmpeg-bro-headless PRIVATE ws2_32)
endif()

# ── tests ─────────────────────────────────────────────────────────────────
#
# Decodes a real file through bro's registry, so it exercises exactly the path
# <video> takes: backend precedence, demux, reordering, seek, audio.
add_executable(ffmpeg-bro-decodetest tests/decode_test.cpp)
target_link_libraries(ffmpeg-bro-decodetest PRIVATE ffmpeg-bro-core bro_video)
target_include_directories(ffmpeg-bro-decodetest PRIVATE "${BRO_DIR}/src")

# Renders a timeline and opens the result: canvas geometry, opacity, the audio
# mix, cancellation, and that what came out is a file this app can read back.
add_executable(ffmpeg-bro-exporttest tests/export_test.cpp)
target_link_libraries(ffmpeg-bro-exporttest PRIVATE ffmpeg-bro-core bro_video)
target_include_directories(ffmpeg-bro-exporttest PRIVATE "${BRO_DIR}/src")

# Where the time in a seek goes: demuxer seek vs decode vs YUV->RGB.
add_executable(ffmpeg-bro-perftest tests/perf_test.cpp)
target_link_libraries(ffmpeg-bro-perftest PRIVATE ffmpeg-bro-core bro_video)
target_include_directories(ffmpeg-bro-perftest PRIVATE "${BRO_DIR}/src")
