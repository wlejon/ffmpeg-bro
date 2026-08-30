#!/usr/bin/env bash
# Stage a release directory for zipping and uploading to GitHub.
#
# Usage:
#   scripts/package-release.sh [--version X.Y.Z] [--build-dir build] [--config Release]
#
# Output: dist/ffmpeg-bro-<version>-<platform>-<arch>/
#
# What a package is, and why it is shaped this way:
#
#   ffmpeg-bro[.exe]        the workbench
#   supercut[.exe]          the second application
#   ffmpeg-bro-headless     the same engine, scripted
#   *.dll                   what the binaries load (Windows only; see below)
#   app/ui/  app/supercut/  the two interfaces
#   docs/                   the manual, so a download explains itself offline
#   LICENSE  README.txt
#
# **The interfaces are under `app/` and not beside the binaries.** The second
# executable is named `supercut` and the directory holding its interface is
# named `supercut`; at one level those are the same name, and a package with
# both at its root cannot be written on a case-sensitive filesystem at all.
# `locateApp` in src/native/app_main.h probes `app/` first for this reason.
#
# **Only Windows copies libraries.** vcpkg's x64-linux and arm64-osx triplets
# are static, so there is nothing beside those binaries to carry; x64-windows is
# dynamic and the toolchain's applocal step has already put the DLLs next to
# each executable at build time. Globbing rather than naming them is deliberate:
# the set is whatever vcpkg.json's feature list resolved to, and a hardcoded
# list here would be a second, staler answer to that.
#
# **macOS gets plain binaries, not a .app bundle.** A bundle would need the
# interface tree inside each of two Contents/MacOS directories, and macOS is the
# platform this application has been run on least. Shipping something honest and
# unpolished beats shipping a bundle nobody has opened. README.txt says so.

set -euo pipefail

VERSION=""
BUILD_DIR="build"
CONFIG="Release"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --build-dir) BUILD_DIR="$2"; shift 2 ;;
        --config) CONFIG="$2"; shift 2 ;;
        -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 1 ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -z "$VERSION" ]]; then
    VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo 0.0.0)"
fi

# Whether binaries land in $BUILD_DIR/<config>/ or directly in $BUILD_DIR is a
# property of the GENERATOR, not of the platform: a Windows build is Visual
# Studio (multi-config) locally and Ninja (single-config) in CI, and keying off
# the platform breaks one of the two.
MULTICONFIG=0
PLATFORM=""
if [[ -f "$BUILD_DIR/CMakeCache.txt" ]]; then
    CACHED_GEN="$(grep -E '^CMAKE_GENERATOR:INTERNAL=' "$BUILD_DIR/CMakeCache.txt" | cut -d= -f2 || true)"
    case "$CACHED_GEN" in
        "Visual Studio"*|Xcode) MULTICONFIG=1 ;;
    esac
    [[ "$CACHED_GEN" == "Visual Studio"* ]] && PLATFORM="win"
fi
if [[ -z "$PLATFORM" ]]; then
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*) PLATFORM="win" ;;
        Darwin)               PLATFORM="macos" ;;
        Linux)                PLATFORM="linux" ;;
        *) echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
    esac
fi
if [[ "$PLATFORM" == "win" ]]; then EXE=".exe"; else EXE=""; fi

case "$(uname -m)" in
    x86_64|amd64)  ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)             ARCH="$(uname -m)" ;;
esac

bin_path() {
    if [[ "$MULTICONFIG" == "1" ]]; then echo "$BUILD_DIR/$CONFIG/$1$EXE";
    else echo "$BUILD_DIR/$1$EXE"; fi
}

TARGETS=(ffmpeg-bro supercut ffmpeg-bro-headless)

MAIN_EXE="$(bin_path ffmpeg-bro)"
if [[ ! -x "$MAIN_EXE" ]]; then
    echo "error: $MAIN_EXE not found. Build first:" >&2
    echo "  cmake --build $BUILD_DIR --config $CONFIG" >&2
    exit 1
fi

OUT_NAME="ffmpeg-bro-${VERSION}-${PLATFORM}-${ARCH}"
OUT_DIR="dist/$OUT_NAME"

echo ">>> Packaging $OUT_NAME"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/app"

# --- Executables -----------------------------------------------------------
for t in "${TARGETS[@]}"; do
    src="$(bin_path "$t")"
    if [[ -x "$src" ]]; then
        cp "$src" "$OUT_DIR/"
    else
        echo "error: $src not found" >&2
        exit 1
    fi
done

# --- What they load (Windows) ---------------------------------------------
# **`nocaseglob`, and it is not tidiness.** vcpkg's mp3lame port installs
# `libmp3lame.DLL`, the one library in this set whose extension is upper case,
# and bash matches a glob case-sensitively even where the filesystem does not.
# So `*.dll` copied forty-four of forty-five and avcodec's import of the
# forty-fifth resolved to nothing. Every Windows package this script has ever
# made was missing it. What hid it is that it only fails on a machine that has
# never built this: a developer has `<vcpkg>/installed/x64-windows/bin` on PATH,
# the loader finds it there, and the packaged tree appears to run. On a clean
# runner the binary does not start at all, with no message and exit 127 — the
# loader names no import it failed to resolve, so the symptom says nothing about
# the cause.
if [[ "$PLATFORM" == "win" ]]; then
    shopt -s nullglob nocaseglob
    for t in "${TARGETS[@]}"; do
        for lib in "$(dirname "$(bin_path "$t")")"/*.dll; do
            cp -a "$lib" "$OUT_DIR/"
        done
    done
    shopt -u nullglob nocaseglob
fi

# --- Strip our own binaries (Linux/macOS) ---------------------------------
# ffmpeg, x265 and bro's static libraries are all linked in, so a Release ELF
# keeps a symbol table far larger than the code. macOS uses -x (drop local
# symbols, keep external) so nothing about a signature or a dylib is disturbed.
if [[ "$PLATFORM" != "win" ]]; then
    STRIP_FLAGS=()
    [[ "$PLATFORM" == "macos" ]] && STRIP_FLAGS=(-x)
    for t in "${TARGETS[@]}"; do
        strip "${STRIP_FLAGS[@]}" "$OUT_DIR/$t" 2>/dev/null \
            || echo "warning: strip failed for $t, shipping unstripped" >&2
    done
fi

# --- The interfaces and the manual ----------------------------------------
cp -a ui "$OUT_DIR/app/"
cp -a supercut "$OUT_DIR/app/"
# The localStorage each interface writes beside itself is a developer's, not a
# release's: shipping one hands every downloader somebody else's remembered
# export settings and graph overlay.
rm -f "$OUT_DIR/app/ui/.storage.json" "$OUT_DIR/app/supercut/.storage.json"
cp -a docs "$OUT_DIR/"
cp LICENSE "$OUT_DIR/"

# --- README.txt -----------------------------------------------------------
{
    cat <<EOF
ffmpeg-bro ${VERSION} (${PLATFORM}-${ARCH})

  ./ffmpeg-bro${EXE} [media-file]      the workbench: open, cut, filter, encode
  ./supercut${EXE} [document.fbro]     find what was said, and cut it together
  ./ffmpeg-bro-headless${EXE} app/ui script.js    the same engine, scripted

ffmpeg is linked into these binaries. There is nothing else to install, and
nothing on your PATH is used or needed.

docs/manual/README.md is the manual, one part per stage. docs/api.md is the
bro.ffmpeg surface the headless binary drives.

supercut reads its corpus from build/corpus/find.json, relative to the
directory you run it from. With none there it can go and get one.

Licensed GPL-3.0-or-later; see LICENSE.
EOF
    if [[ "$PLATFORM" == "macos" ]]; then
        cat <<'EOF'

Unsigned build
--------------
These binaries are not codesigned or notarized, so Gatekeeper quarantines them
after download:

  xattr -dr com.apple.quarantine .

They are plain executables rather than .app bundles, so double-clicking one
opens a Terminal window with it. Run them from a terminal.
EOF
    fi
} > "$OUT_DIR/README.txt"

# --- Report ---------------------------------------------------------------
echo ""
echo "Staged: $OUT_DIR"
command -v du >/dev/null 2>&1 && du -sh "$OUT_DIR" | awk '{print "Staged size: " $1}'
echo ""
echo "Next: verify by running"
echo "  (cd $OUT_DIR && ./ffmpeg-bro$EXE)"
