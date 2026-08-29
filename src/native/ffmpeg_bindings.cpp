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

#include <string>

namespace ffmpegbro {

namespace {
std::string g_initialMedia;
}

void setInitialMedia(const std::string& path) { g_initialMedia = path; }

void installFfmpegBindings(JSContext* ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue broObj = JS_GetPropertyStr(ctx, global, "bro");
    if (JS_IsUndefined(broObj) || JS_IsNull(broObj)) {
        JS_FreeValue(ctx, broObj);
        broObj = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, global, "bro", JS_DupValue(ctx, broObj));
    }

    {
        // Scoped, because a table attaches itself to its parent when it goes
        // out of scope — `bro.ffmpeg` has to be there before `broObj` is freed.
        Table ns(ctx, broObj, "ffmpeg");

        // Linked in, not looked up on PATH: if this binary runs, ffmpeg is
        // here. The only two properties left at this level that are facts about
        // the binary rather than about libav — everything libav can tell us is
        // `installCapabilities`.
        ns.value("available", JS_TRUE);
        ns.value("linked", JS_TRUE);

        installProbe(ns);
        installData(ns);
        installMarks(ns);
        installTranscribe(ns);
        installWords(ns);
        installCapabilities(ns);
        installExpression(ns);
        installSequences(ns);
        installPlayback(ns);
        installRender(ns);
        installFetch(ns);
        installProxy(ns);
        installCapture(ns);

        ns.value("openOnStart",
                 g_initialMedia.empty()
                     ? JS_NULL
                     : JS_NewStringLen(ctx, g_initialMedia.data(), g_initialMedia.size()));
    }

    JS_FreeValue(ctx, broObj);
    JS_FreeValue(ctx, global);
}

} // namespace ffmpegbro
