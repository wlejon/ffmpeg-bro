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
# one build of it. The encode half is several files rather than one: each stage of the render —
# what the sources are, how a frame is composited, what the file is written
# with — changes for different reasons, and two-pass, stream copy and the
# hardware paths each need one of them to change without touching the others.
add_library(ffmpeg-bro-core STATIC
    src/native/ffmpeg_backend.cpp
    src/native/ffmpeg_bindings.cpp
    src/native/ffmpeg_capabilities.cpp
    src/native/ffmpeg_export.cpp
    src/native/ffmpeg_input.cpp
    src/native/ffmpeg_report.cpp
    src/native/ffmpeg_sequence.cpp
    src/native/export_compositor.cpp
    src/native/export_frame.cpp
    src/native/export_graph.cpp
    src/native/export_source.cpp
    src/native/export_timeline.cpp
    src/native/export_writer.cpp
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
# libav's headers as well as bro's: a multi-stream file is checked by opening it
# with libavformat and reading the dispositions and codec tags off the streams,
# which probeMedia() deliberately does not report.
target_include_directories(ffmpeg-bro-exporttest
                           PRIVATE "${BRO_DIR}/src" ${FFMPEG_INCLUDE_DIRS})

# What this build can write, read, reach and capture: the registry walks
# behind the muxer picker, the option tables behind the columns, and a render
# into a muxer chosen by name rather than by filename.
add_executable(ffmpeg-bro-captest tests/capability_test.cpp)
target_link_libraries(ffmpeg-bro-captest PRIVATE ffmpeg-bro-core bro_video)
# libav's headers as well: what a muxer wrote is checked by opening the result
# and asking libavformat what it thinks the file is.
target_include_directories(ffmpeg-bro-captest
                           PRIVATE "${BRO_DIR}/src" ${FFMPEG_INCLUDE_DIRS})

# An input is an `-i`: a forced demuxer, an option bag whose unknown keys are
# errors, a window that moves the input's own clock, and the token playback
# opens one by.
add_executable(ffmpeg-bro-inputtest tests/input_test.cpp)
target_link_libraries(ffmpeg-bro-inputtest PRIVATE ffmpeg-bro-core bro_video)
target_include_directories(ffmpeg-bro-inputtest
                           PRIVATE "${BRO_DIR}/src" ${FFMPEG_INCLUDE_DIRS})

# Inputs whose content is assembled rather than opened: an image sequence, a
# still held for a chosen length, `-stream_loop`, the concat demuxer, and a
# render that writes a run of files rather than one.
add_executable(ffmpeg-bro-seqtest tests/sequence_test.cpp)
target_link_libraries(ffmpeg-bro-seqtest PRIVATE ffmpeg-bro-core bro_video)
target_include_directories(ffmpeg-bro-seqtest
                           PRIVATE "${BRO_DIR}/src" ${FFMPEG_INCLUDE_DIRS})

# Where the time in a seek goes: demuxer seek vs decode vs YUV->RGB.
add_executable(ffmpeg-bro-perftest tests/perf_test.cpp)
target_link_libraries(ffmpeg-bro-perftest PRIVATE ffmpeg-bro-core bro_video)
target_include_directories(ffmpeg-bro-perftest PRIVATE "${BRO_DIR}/src")

# Media to test against, generated rather than checked in — deterministic
# content, a known tone, and two files that differ in size, aspect, rate and
# length. See tests/make_fixture.cpp for why that matters.
add_executable(ffmpeg-bro-mkfixture tests/make_fixture.cpp)
target_link_libraries(ffmpeg-bro-mkfixture PRIVATE ffmpeg-bro-core)
# It writes through the renderer's own Writer, so it needs libav's headers the
# way ffmpeg-bro-core does.
target_include_directories(ffmpeg-bro-mkfixture
                           PRIVATE "${BRO_DIR}/src" ${FFMPEG_INCLUDE_DIRS})

# ── ctest ─────────────────────────────────────────────────────────────────
#
# `ctest --test-dir build -C Release` runs everything. The fixtures are a
# CTest fixture in the literal sense: one setup test writes them and every
# other test declares that it needs them, so they are made once, before, and
# only when something is going to use them.
enable_testing()
set(FIXTURE_DIR "${CMAKE_CURRENT_BINARY_DIR}/fixtures")
set(FIXTURE_A "${FIXTURE_DIR}/landscape.mp4")
set(FIXTURE_B "${FIXTURE_DIR}/portrait.mp4")

add_test(NAME fixtures COMMAND ffmpeg-bro-mkfixture "${FIXTURE_DIR}")
set_tests_properties(fixtures PROPERTIES FIXTURES_SETUP media)

add_test(NAME decode COMMAND ffmpeg-bro-decodetest "${FIXTURE_A}")
add_test(NAME export COMMAND ffmpeg-bro-exporttest "${FIXTURE_A}" "${FIXTURE_B}")
add_test(NAME capabilities COMMAND ffmpeg-bro-captest "${FIXTURE_A}")
add_test(NAME inputs COMMAND ffmpeg-bro-inputtest "${FIXTURE_A}")
add_test(NAME sequences COMMAND ffmpeg-bro-seqtest "${FIXTURE_DIR}")
add_test(NAME ui-player COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_player.js"
         -- "${FIXTURE_A}" "${FIXTURE_B}")
# The Sources stage as the input editor: an input added by typing a path, a
# demuxer forced, an option set, a window cut, and every one of those printed
# before its own -i.
add_test(NAME ui-sources COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_sources.js"
         -- "${FIXTURE_A}")
add_test(NAME ui-export COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_export.js"
         -- "${FIXTURE_A}")
# What a render said, from av_log inside libav to a line somebody can read:
# the drain off the frame loop, a warning that is visible, and a measuring
# filter's values as a series over time.
add_test(NAME ui-report COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_report.js"
         -- "${FIXTURE_A}")
set_tests_properties(decode export capabilities inputs sequences ui-player ui-sources
                     ui-export ui-report PROPERTIES
                     FIXTURES_REQUIRED media TIMEOUT 900)

# Needs no media at all: buildSpec()'s output is a plain object and the
# translation into a filter graph is a pure function of it. ui-graph is the
# same code from underneath — the model, the printer's chain rule and the
# round trip through storage, none of which has a printed form.
add_test(NAME ui-filtergraph COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_filtergraph.js")
add_test(NAME ui-graph COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_graph.js")
set_tests_properties(ui-filtergraph ui-graph PROPERTIES TIMEOUT 300)

# The headless binary writes screenshots and renders relative to its working
# directory, and the tests read them back the same way.
set_tests_properties(export capabilities sequences ui-player ui-sources ui-export
                     ui-report
                     PROPERTIES WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
