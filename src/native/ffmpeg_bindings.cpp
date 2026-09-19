// bro.ffmpeg — the JS surface of the linked libav libraries, assembled.
//
// This file was once all of it. At two thousand lines, reading a render spec,
// walking libavformat's muxer registry and handing a token to a `<video>` all
// sat next to each other for no reason beyond having been written at the same
// time — and worst of all, the paragraph saying *why* a recording shares
// `render.poll()` sat three hundred lines from `record.start`.
//
// What is left here is the assembly: the object, the two facts that are about
// *this binary* rather than about libav, and a list of the parts. The parts are
// in bindings_install.h, one per part of ffmpeg's own model; `Table` is in
// bindings_table.h.

#include "ffmpeg_bindings.h"

#include "bindings_install.h"
#include "bindings_table.h"
#include "bindings_value.h"
#include "util/log.h"

#include <embed/embed.h>
#include <string>

namespace ffmpegbro {

namespace {
std::string g_initialMedia;
}

void setInitialMedia(const std::string& path) { g_initialMedia = path; }

void installFfmpegBindings(bro::engine::Engine& /*engine*/) {
    namespace ev = bronze::embed;

    ev::GlobalValue broGlobal = ev::globalValue("bro");
    if (!broGlobal.found || !ev::isObject(broGlobal.value)) {
        LOG_WARN("installFfmpegBindings: 'bro' global not found or not an object");
        return;
    }

    ev::Persistent broObj(broGlobal.value);
    bronze::Value ffmpegVal = ev::getProperty(broObj.get(), "ffmpeg");
    if (!ev::isObject(ffmpegVal)) {
        ev::Persistent created(ev::createObject());
        broObj.set(ev::setProperty(broObj.get(), "ffmpeg", created.get()));
        ffmpegVal = created.get();
    }

    {
        Table rootTable(ffmpegVal);

        // Linked in, not looked up on PATH: if this binary runs, ffmpeg is
        // here. The only two properties left at this level that are facts about
        // the binary rather than about libav — everything libav can tell us is
        // `installCapabilities`.
        rootTable.value("available", true);
        rootTable.value("linked", true);

        installProbe(rootTable);
        installData(rootTable);
        installMarks(rootTable);
        installTranscribe(rootTable);
        installWords(rootTable);
        installCapabilities(rootTable);
        installExpression(rootTable);
        installSequences(rootTable);
        installPlayback(rootTable);
        installRender(rootTable);
        installFetch(rootTable);
        installProxy(rootTable);
        installCapture(rootTable);

        if (g_initialMedia.empty()) {
            rootTable.value("openOnStart", ev::null());
        } else {
            rootTable.value("openOnStart", g_initialMedia);
        }
    }
}

} // namespace ffmpegbro
