// See bindings_value.h for what these are and why they are not qjsbind's.

#include "bindings_value.h"

namespace ffmpegbro {

void setStr(JSContext* ctx, JSValue obj, const char* key, const std::string& v) {
    JS_SetPropertyStr(ctx, obj, key, JS_NewStringLen(ctx, v.data(), v.size()));
}

double numProp(JSContext* ctx, JSValueConst obj, const char* key, double fallback) {
    JSValue v = JS_GetPropertyStr(ctx, obj, key);
    double out = fallback;
    if (!JS_IsUndefined(v) && !JS_IsNull(v)) {
        double d = 0;
        if (JS_ToFloat64(ctx, &d, v) == 0 && d == d) out = d;
    }
    JS_FreeValue(ctx, v);
    return out;
}

bool boolProp(JSContext* ctx, JSValueConst obj, const char* key, bool fallback) {
    JSValue v = JS_GetPropertyStr(ctx, obj, key);
    const bool out = (JS_IsUndefined(v) || JS_IsNull(v)) ? fallback : JS_ToBool(ctx, v) == 1;
    JS_FreeValue(ctx, v);
    return out;
}

std::string strProp(JSContext* ctx, JSValueConst obj, const char* key,
                    const std::string& fallback) {
    JSValue v = JS_GetPropertyStr(ctx, obj, key);
    std::string out = fallback;
    if (JS_IsString(v)) {
        size_t len = 0;
        if (const char* s = JS_ToCStringLen(ctx, &len, v)) {
            out.assign(s, len);
            JS_FreeCString(ctx, s);
        }
    }
    JS_FreeValue(ctx, v);
    return out;
}

uint32_t arrayLength(JSContext* ctx, JSValueConst arr) {
    JSValue lenv = JS_GetPropertyStr(ctx, arr, "length");
    uint32_t len = 0;
    JS_ToUint32(ctx, &len, lenv);
    JS_FreeValue(ctx, lenv);
    return len;
}

bool takeName(JSContext* ctx, JSValueConst v, std::string* out) {
    if (!JS_IsString(v)) return false;
    size_t len = 0;
    const char* s = JS_ToCStringLen(ctx, &len, v);
    if (!s) return false;
    out->assign(s, len);
    JS_FreeCString(ctx, s);
    return true;
}

JSValue stringsToJs(JSContext* ctx, const std::vector<std::string>& v) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& s : v)
        JS_SetPropertyUint32(ctx, arr, i++, JS_NewStringLen(ctx, s.data(), s.size()));
    return arr;
}

JSValue intsToJs(JSContext* ctx, const std::vector<int>& v) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (int n : v) JS_SetPropertyUint32(ctx, arr, i++, JS_NewInt32(ctx, n));
    return arr;
}

JSValue channelsToJs(JSContext* ctx, const std::vector<ChannelLevel>& v) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const ChannelLevel& c : v) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", c.name);
        // Both peaks, because the distance between them is itself a reading and
        // because a meter has to be able to say which one it is drawing. See
        // sound_meter.h.
        JS_SetPropertyStr(ctx, o, "truePeak", JS_NewFloat64(ctx, c.truePeak));
        JS_SetPropertyStr(ctx, o, "peak", JS_NewFloat64(ctx, c.peak));
        JS_SetPropertyStr(ctx, o, "rms", JS_NewFloat64(ctx, c.rms));
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    return arr;
}

} // namespace ffmpegbro
