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

# ── bro's acoustic sensors ────────────────────────────────────────────────
#
# `bro.sense` is bro's model-free acoustic sensor bus — level, voice,
# spectral-flux onset and autocorrelation tonality, one reading per 10 ms frame
# over a shared PCEN mel front-end — and `bro.sense.analyze()` is the one call
# in it that runs offline over a buffer rather than off a live microphone, which
# is what a soundtrack needs. Nothing in `ui/` reads it yet; this turns it on so
# that something can. bro installs that namespace as *unavailable*
# (`src/js/feature_stubs.cpp`) unless `BRO_WITH_SOUNDML` is on, and it is off in
# bro's default `app` profile, so a plain `cmake -B build` used to produce a
# binary in which the call threw "built without BRO_WITH_SOUNDML".
#
# **The cache entry has to exist before `add_subdirectory`.** bro declares the
# flag with `option()`, which leaves an existing cache entry alone — which is
# also exactly why `-DBRO_WITH_SOUNDML=OFF` on the command line still wins.
#
# **One flag rather than `-DBRO_PROFILE=full`.** bro's `_bro_require` chain
# forces `BRO_WITH_LM` (brolm) and `BRO_WITH_TENSOR` (brotensor) on from this
# one, and `BRO_WITH_AUDIO` is on in every profile — so this is four features,
# and they are the four this application has a use for. `full` would add
# brovisionml and brodiffusion on top, 240 source files nothing here asks
# anything of.
#
# **Nothing is downloaded and no port is added.** brotensor, brolm and
# brosoundml want nothing from vcpkg beyond what the `app` profile already
# installs, and all three are MIT like bro: what makes this binary GPL is still
# libav* and nothing else. Where bro finds them is worth knowing, because it is
# not where it reads: it resolves `../<name>` against `CMAKE_SOURCE_DIR`, which
# is *this* project rather than bro, so a standalone checkout beside **this**
# repo wins and bro's own git submodule is the fallback. A `git clone` of bro
# without `--recursive` has neither, and bro's submodule preflight only covers
# quickjs/SDL/jolt — so that failure names a missing `CMakeLists.txt`.
#
# **What it costs is much less than the source count suggests**, and the reason
# is worth writing down: those 684 files (bro's own count, docs/build-options.md)
# build into static libraries and the linker takes what is referenced. Nothing
# here calls a language model, so
# nothing of brolm past what `bro_js` names is in the binary. From an empty
# build directory on this machine: configure 62 s -> 62 s (unchanged), build
# 431 s -> 458 s, `ffmpeg-bro.exe` 26.35 MB -> 29.07 MB. The build tree is
# where it shows and none of that is shipped: 163 MB -> 196 MB of `.lib`,
# 677 MB -> 752 MB in all.
set(BRO_WITH_SOUNDML ON CACHE BOOL "brosoundml — the sensors behind bro.sense")

# bro builds as static libraries; BRO_BUILD_EXECUTABLES defaults OFF when bro
# is not the top-level project, so this does NOT produce a second bro.exe.
add_subdirectory("${BRO_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/bro")

# ── ffmpeg ────────────────────────────────────────────────────────────────
#
# Linking these is what makes this binary GPL, and the reason this
# application lives outside bro's MIT tree.
find_package(FFMPEG REQUIRED)

# The backend + its JS surface, as a library so the app and its tests share
# one build of it. The encode half is several files rather than one: each stage of the render —
# what the sources are, how a frame is composited, what the file is written
# with — changes for different reasons, and two-pass, stream copy and the
# hardware paths each need one of them to change without touching the others.
# The `bindings_*` half is split along the same seam for the same reason: one
# file per part of ffmpeg's own model, each owning the calls, the helpers that
# build their answers and the prose saying why they are shaped that way. See
# src/native/bindings_install.h.
add_library(ffmpeg-bro-core STATIC
    src/native/ffmpeg_backend.cpp
    src/native/ffmpeg_bindings.cpp
    src/native/bindings_value.cpp
    src/native/bindings_spec.cpp
    src/native/bindings_probe.cpp
    src/native/bindings_render.cpp
    src/native/bindings_capture.cpp
    src/native/bindings_capabilities.cpp
    src/native/bindings_expr.cpp
    src/native/bindings_data.cpp
    src/native/bindings_marks.cpp
    src/native/bindings_playback.cpp
    src/native/bindings_sequence.cpp
    src/native/ffmpeg_capabilities.cpp
    src/native/ffmpeg_data.cpp
    src/native/data_gpmf.cpp
    src/native/ffmpeg_capture.cpp
    src/native/capture_graph.cpp
    src/native/ffmpeg_export.cpp
    src/native/ffmpeg_hardware.cpp
    src/native/ffmpeg_input.cpp
    src/native/ffmpeg_job.cpp
    src/native/ffmpeg_report.cpp
    src/native/playback_filter.cpp
    src/native/playback_output.cpp
    src/native/probe_async.cpp
    src/native/sound_marks.cpp
    src/native/sound_meter.cpp
    src/native/ffmpeg_sequence.cpp
    src/native/export_compositor.cpp
    src/native/export_copy.cpp
    src/native/export_frame.cpp
    src/native/export_graph.cpp
    src/native/export_source.cpp
    src/native/export_sub2video.cpp
    src/native/export_subtitle.cpp
    src/native/export_timeline.cpp
    src/native/export_writer.cpp
)
target_include_directories(ffmpeg-bro-core
    PUBLIC  "${CMAKE_CURRENT_SOURCE_DIR}/src/native"
    PRIVATE "${BRO_DIR}/src" ${FFMPEG_INCLUDE_DIRS}
)
target_link_libraries(ffmpeg-bro-core PRIVATE bro_video qjs qjsbind ${FFMPEG_LIBRARIES})
target_link_directories(ffmpeg-bro-core PRIVATE ${FFMPEG_LIBRARY_DIRS})

# ── bro's acoustic sensors, linked rather than called through JS ───────────
#
# `src/native/sound_marks.cpp` drives `brosoundml::SensorHub` directly — the same
# class, the same configuration and the same framing loop `bro.sense.analyze()`
# runs — because that call is synchronous on the UI thread and was measured at
# ~58x realtime, which is a 5.4-second frozen window for a five-minute clip and
# about thirty-one seconds for half an hour. The reasoning in full, including why
# chunking `analyze` is not the fix, is at the top of src/native/sound_marks.h.
#
# `brosoundml` is a target in this build tree already: the `BRO_WITH_SOUNDML`
# cache entry set above makes bro's `third_party/CMakeLists.txt` add it, from the
# standalone `../brosoundml` beside *this* repo where there is one and from bro's
# submodule otherwise. `brotensor` comes with it, PUBLIC, because the mel
# front-end is composed of its ops. So this adds no source, no download and no
# port — only a link line and a name on the include path.
#
# **`-DBRO_WITH_SOUNDML=OFF` is a supported configuration and stays one.** The
# link and the compile definition are both conditional, sound_marks.cpp compiles
# to a refusal that names the flag, and `bro.ffmpeg.marks.available()` answers
# false so the UI does not offer a control that would fail. PUBLIC on both counts
# because ffmpeg-bro-core is a static library: its consumers need brosoundml's
# archive at link time, and the tests need the macro to know which of the two
# behaviours to assert.
if(BRO_WITH_SOUNDML)
    if(NOT TARGET brosoundml::brosoundml)
        message(FATAL_ERROR
            "BRO_WITH_SOUNDML is ON but no brosoundml target was created. bro "
            "resolves ../brosoundml against ${CMAKE_CURRENT_SOURCE_DIR} and "
            "falls back to its own submodule, so a `git clone` of bro without "
            "--recursive and no sibling checkout has neither.")
    endif()
    target_link_libraries(ffmpeg-bro-core PUBLIC brosoundml::brosoundml)
    # bro's own flag name rather than a second one for the same fact. bro
    # declares it with `option()`, which makes it a cache variable and not a
    # compile definition — bro's own `src/js` does exactly this for the same
    # reason, and `#if BRO_WITH_SOUNDML` in sound_marks.cpp reads it.
    target_compile_definitions(ffmpeg-bro-core PUBLIC BRO_WITH_SOUNDML=1)
endif()

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

# A device is an input and recording is a job: an endless input reported as
# endless, a bounded capture that ends by itself, and a stopped one that still
# leaves a file with an index in it. Driven by `lavfi`, which is a device and
# exists on every machine.
add_executable(ffmpeg-bro-capturetest tests/capture_test.cpp)
target_link_libraries(ffmpeg-bro-capturetest PRIVATE ffmpeg-bro-core bro_video)
# libav's headers as well: what was recorded is checked by opening it and
# asking libavformat whether it can seek back to the start, which is what
# having an index means.
target_include_directories(ffmpeg-bro-capturetest
                           PRIVATE "${BRO_DIR}/src" ${FFMPEG_INCLUDE_DIRS})

# A data stream, read: which parser answers for which fourcc, what GPMF says,
# and — the bulk of it — what the parser does with a payload it is not allowed
# to trust. Truncated at every boundary, scribbled on header by header, nested
# two hundred deep and fed a megabyte of noise. The `tests/` directory is on the
# include path for `gpmf_write.h`, which is shared with the fixture generator so
# that the bytes damaged here are the bytes the fixture holds.
add_executable(ffmpeg-bro-datatest tests/data_test.cpp)
target_link_libraries(ffmpeg-bro-datatest PRIVATE ffmpeg-bro-core bro_video)
target_include_directories(ffmpeg-bro-datatest
                           PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/tests"
                                   "${BRO_DIR}/src" ${FFMPEG_INCLUDE_DIRS})

# A soundtrack, read for where things happen in it: does the sensor bus find a
# moment, and is it *the* moment. Almost every assertion is a number of seconds
# against the fixture that was written with events at known ones — plus the one
# physical measurement in the feature, the dominant frequency of a tonal run,
# and the refusal a build with no brosoundml in it gives instead.
add_executable(ffmpeg-bro-markstest tests/marks_test.cpp)
target_link_libraries(ffmpeg-bro-markstest PRIVATE ffmpeg-bro-core bro_video)
target_include_directories(ffmpeg-bro-markstest
                           PRIVATE "${BRO_DIR}/src" ${FFMPEG_INCLUDE_DIRS})

# The GPU: what this machine has, whether a hardware decode is the same
# picture, and what each path costs. Most of it is a measurement rather than an
# assertion, and every assertion has to pass on a machine with no card at all.
add_executable(ffmpeg-bro-hwtest tests/hardware_test.cpp)
target_link_libraries(ffmpeg-bro-hwtest PRIVATE ffmpeg-bro-core bro_video)
target_include_directories(ffmpeg-bro-hwtest
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
# `gpmf_write.h` lives beside it: the telemetry fixture's payload is real GPMF
# and is built by the same code the parser test damages.
target_include_directories(ffmpeg-bro-mkfixture
                           PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/tests")
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
# A file with **no audio stream in it at all**, which is not the same file as
# one whose soundtrack is quiet: it is the only thing that separates "the mix"
# from "a mix nothing feeds", and every screen in this application used to
# claim a soundtrack for it.
set(FIXTURE_SILENT "${FIXTURE_DIR}/silent.mp4")
# The mirror of it: sound and **no video stream at all**. A clip of one is an
# ordinary clip that contributes to the mix and to nothing else, and every
# screen in this application used to claim a picture for it — a black rectangle
# in the viewer, an empty filmstrip on the lane, a composite on the Write stage.
set(FIXTURE_SOUND "${FIXTURE_DIR}/sound.m4a")
# Pictures stored one way up and meant to be seen another, which is what every
# phone writes. Nothing here can be told from the pixels: it is a display matrix
# on the stream, and it is the only thing saying a 640x360 file is shown 360x640.
set(FIXTURE_ROTATED "${FIXTURE_DIR}/rotated.mp4")
# A stream that is neither picture, sound nor cues: a `gpmd` telemetry track
# beside an ordinary clip. Nothing decodes one, so the fourcc is its whole
# identity — a copy that drops the tag still writes a data track of the right
# length at the right times that the reader it was carried for cannot find.
set(FIXTURE_DATA "${FIXTURE_DIR}/telemetry.mp4")
# The one soundtrack here in which something happens: transients at 1, 3 and 5
# seconds and a 1000 Hz tone from 6.0 to 7.5, over a bed too quiet to be either.
# Every other fixture's sound is a continuous tone, which is exactly what a mix
# check wants and is useless for a detector — in a tone nothing ever happens, so
# "found nothing" and "was never called" are the same result.
set(FIXTURE_MARKS "${FIXTURE_DIR}/marks.m4a")

# A real camera file, if this machine has one. Nothing in the suite requires it
# — every section that uses it says what it found and skips otherwise — but a
# parser for somebody else's format is only really tested by somebody else's
# file, so there is a way to point at one.
set(GOPRO_FILE "" CACHE FILEPATH "a real GoPro .MP4 to check the gpmd parser against")

add_test(NAME fixtures COMMAND ffmpeg-bro-mkfixture "${FIXTURE_DIR}")
set_tests_properties(fixtures PROPERTIES FIXTURES_SETUP media)

# The other thing a UI suite needs before it starts is *nothing left over*.
# localStorage is written beside the app, so `ui/.storage.json` outlives the run
# that made it — by design for the application, and a hazard for a test, because
# every reader in `ui/` sanitises a blob written by an earlier version of this
# code and a suite that finds one is exercising a different input than the one
# it states. It has already cost a false failure: a run that left a node behind
# put the overlay's id counter past where the next suite expected to find it,
# and the failure named the id policy rather than the leftover file.
add_test(NAME clean-storage COMMAND "${CMAKE_COMMAND}" -E rm -f
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/.storage.json")
set_tests_properties(clean-storage PROPERTIES FIXTURES_SETUP storage)

# The plain arguments are files to put through the whole walk; the two named
# ones are the fixtures whose *point* is a single fact, so the fact is asserted
# by name rather than guessed at from a filename.
add_test(NAME decode COMMAND ffmpeg-bro-decodetest "${FIXTURE_A}"
         --rotated "${FIXTURE_ROTATED}" --sound-only "${FIXTURE_SOUND}")
add_test(NAME export COMMAND ffmpeg-bro-exporttest "${FIXTURE_A}" "${FIXTURE_B}")
add_test(NAME capabilities COMMAND ffmpeg-bro-captest "${FIXTURE_A}")
add_test(NAME inputs COMMAND ffmpeg-bro-inputtest "${FIXTURE_A}" "${FIXTURE_ROTATED}"
         "${FIXTURE_DIR}/cues.srt")
add_test(NAME sequences COMMAND ffmpeg-bro-seqtest "${FIXTURE_DIR}")
# The parser behind a data stream, and the hostile file it has to survive. The
# fixture carries real GPMF; an optional second argument is a real camera file,
# and the section that needs one says so and skips when there is none —
# `-DGOPRO_FILE=<path>` at configure time is how a machine that has one passes
# it in without checking a 4 GB file into anything.
add_test(NAME telemetry COMMAND ffmpeg-bro-datatest "${FIXTURE_DATA}" "${GOPRO_FILE}")
# Where things happen in a soundtrack. The first file is the only fixture here
# in which anything *does* — a continuous tone cannot separate a detector that
# found nothing from one that was never called. The second and third are the
# controls: a file with no audio stream at all, which has to be refused rather
# than answered with an empty list, and a six-second tone, which has to be one
# run and no transients.
add_test(NAME marks COMMAND ffmpeg-bro-markstest "${FIXTURE_MARKS}"
         "${FIXTURE_SILENT}" "${FIXTURE_SOUND}")
add_test(NAME hardware COMMAND ffmpeg-bro-hwtest "${FIXTURE_A}")
# The device it records from is `lavfi`, which produces its own pictures, so
# most of this needs no fixture at all. What does is the half about a file laid
# *over* a device — a title card is a file, and there has to be one — so the
# fixture directory is passed as well and those sections skip without it. It
# writes into out/, so it wants the source directory.
add_test(NAME capture COMMAND ffmpeg-bro-capturetest "out" "${FIXTURE_DIR}")
set_tests_properties(capture PROPERTIES TIMEOUT 300 FIXTURES_REQUIRED media
                     WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
# The third and fourth files are the two whose point is one fact each: a clip
# stored sideways has to play the right way up, and a clip with no picture in it
# has to be an ordinary clip. Both sections are skipped without them, which is
# what keeps this runnable by hand against two files.
add_test(NAME ui-player COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_player.js"
         -- "${FIXTURE_A}" "${FIXTURE_B}" "${FIXTURE_ROTATED}" "${FIXTURE_SOUND}")
# The Sources stage as the input editor: an input added by typing a path, a
# demuxer forced, an option set, a window cut, and every one of those printed
# before its own -i.
add_test(NAME ui-sources COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_sources.js"
         -- "${FIXTURE_A}")
# The GPU from the two places a person decides about it: which device an input
# decodes on, which encoder a stream is written with, and the one sentence that
# says a hardware decode is measured slower here than the CPU.
add_test(NAME ui-hardware COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_hardware.js"
         -- "${FIXTURE_A}")
# The second file has no audio stream in it and the third has no video stream,
# which are the two halves of the same question: what does this application
# write for a file that is missing one of the streams it takes for granted. The
# fourth is the other direction — a file with a stream this application had no
# row for at all.
add_test(NAME ui-export COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_export.js"
         -- "${FIXTURE_A}" "${FIXTURE_SILENT}" "${FIXTURE_SOUND}" "${FIXTURE_DATA}")
# Inputs that are assembled, from the drop that groups them to the Write stage
# that says what a run of files will be called. Takes the fixture *directory*
# rather than one file, because what it is about is a folder of frames.
add_test(NAME ui-sequence COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_sequence.js"
         -- "${FIXTURE_DIR}")
# What a render said, from av_log inside libav to a line somebody can read:
# the drain off the frame loop, a warning that is visible, and a measuring
# filter's values as a series over time.
add_test(NAME ui-report COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_report.js"
         -- "${FIXTURE_A}")
# Filters whose output is information, from putting one on the graph to acting
# on what it found: a measurement started, a plot drawn, a crop applied, a
# refusal shown instead of a silent rewrite, and the A/B comparison measured
# with psnr/ssim rather than judged by eye.
add_test(NAME ui-measure COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_measure.js"
         -- "${FIXTURE_A}")
# The three things people mean by subtitles, each of which is a different
# mechanism: a track beside the picture, a burn-in through libavfilter, and a
# file on its own. Takes the fixture *directory* because it needs the video and
# the cues that were written to go with it.
add_test(NAME ui-subtitles COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_subtitles.js"
         -- "${FIXTURE_DIR}")
# The whole edit as one object, round-tripped through a file. Takes two videos
# because the fact that matters most is an *identity* one — a graph node names
# `in3` and an anchor names `clip:7`, and both have to mean the same file and the
# same shot after the document has been opened over the top of a different edit.
# One file cannot tell a renumbering from a correct answer.
add_test(NAME ui-document COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_document.js"
         -- "${FIXTURE_A}" "${FIXTURE_B}")
# A data track, read and put on the timeline. The fixture carries real GPMF
# whose divisors are the difference between 9.81 and 981, so what this can check
# that a screenshot cannot is that the number on the lane is the number the file
# means. Everything about *shape* also holds against a real camera file, and the
# sections about the fixture's own values say so and skip.
add_test(NAME ui-telemetry COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_telemetry.js"
         -- "${FIXTURE_DATA}")
# Where something happens in a soundtrack, from the press to the lane to the two
# keys that walk it. The second file has no audio stream at all, which is what
# says the control is drawn where it will work rather than everywhere with a
# refusal behind it.
add_test(NAME ui-marks COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_marks.js"
         -- "${FIXTURE_MARKS}" "${FIXTURE_SILENT}")
# The render on the program monitor instead of the clips. One file: what this is
# about is the three things one element per clip cannot show, and all three of
# them are about the *canvas* rather than about which file is on it.
add_test(NAME ui-output COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_output.js"
         -- "${FIXTURE_A}")
set_tests_properties(decode export capabilities inputs sequences hardware telemetry marks
                     PROPERTIES FIXTURES_REQUIRED media TIMEOUT 900)
# The same, plus clean storage — the split is that a native test never loads
# `ui/`, so the blob beside the app is nothing to do with it.
set_tests_properties(ui-player ui-sources ui-hardware ui-export ui-sequence ui-report
                     ui-measure ui-subtitles ui-document ui-output ui-telemetry ui-marks
                     PROPERTIES FIXTURES_REQUIRED "media;storage" TIMEOUT 900)

# Needs no media at all: buildSpec()'s output is a plain object and the
# translation into a filter graph is a pure function of it. ui-graph is the
# same code from underneath — the model, the printer's chain rule and the
# round trip through storage, none of which has a printed form.
add_test(NAME ui-filtergraph COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_filtergraph.js")
# The Capture stage needs no media either — the device it records from is
# `lavfi`, which makes its own pictures. It writes into out/, so it wants the
# source directory.
add_test(NAME ui-capture COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_capture.js")
set_tests_properties(ui-capture PROPERTIES FIXTURES_REQUIRED storage TIMEOUT 600
                     WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
# ui-graph is mostly the model, which needs nothing, but the wiring gesture is
# a gesture: sockets have to be somewhere before a wire can be dragged between
# them, and nothing is anywhere until there is an edit to derive a graph from.
# So it takes a fixture and skips that half without one, which is what keeps it
# runnable by hand against a real file.
add_test(NAME ui-graph COMMAND ffmpeg-bro-headless
         "${CMAKE_CURRENT_SOURCE_DIR}/ui/" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ui_graph.js"
         -- "${FIXTURE_A}")
set_tests_properties(ui-filtergraph PROPERTIES FIXTURES_REQUIRED storage TIMEOUT 300)
set_tests_properties(ui-graph PROPERTIES FIXTURES_REQUIRED "media;storage" TIMEOUT 300)

# The headless binary writes screenshots and renders relative to its working
# directory, and the tests read them back the same way.
set_tests_properties(export capabilities sequences hardware ui-player ui-sources ui-hardware ui-export
                     ui-sequence ui-report ui-measure ui-subtitles ui-document ui-output
                     PROPERTIES WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
