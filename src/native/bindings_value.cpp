// See bindings_value.h for what these are and why they are not QuickJS's.

#include "bindings_value.h"

#include <cmath>

namespace ffmpegbro {

void setStr(bronze::Value obj, const char* key, const std::string& v) {
    namespace ev = bronze::embed;
    ev::setProperty(obj, key, ev::fromUtf8(v));
}

void setNum(bronze::Value obj, const char* key, double val) {
    namespace ev = bronze::embed;
    ev::setProperty(obj, key, ev::fromDouble(val));
}

void setBool(bronze::Value obj, const char* key, bool val) {
    namespace ev = bronze::embed;
    ev::setProperty(obj, key, ev::fromBool(val));
}

double numProp(bronze::Value obj, const char* key, double fallback) {
    namespace ev = bronze::embed;
    if (!ev::isObject(obj)) return fallback;
    bronze::Value v = ev::getProperty(obj, key);
    if (ev::isUndefined(v) || ev::isNull(v)) return fallback;
    if (ev::isNumber(v)) {
        double d = ev::toDouble(v);
        if (!std::isnan(d)) return d;
    }
    return fallback;
}

bool boolProp(bronze::Value obj, const char* key, bool fallback) {
    namespace ev = bronze::embed;
    if (!ev::isObject(obj)) return fallback;
    bronze::Value v = ev::getProperty(obj, key);
    if (ev::isUndefined(v) || ev::isNull(v)) return fallback;
    return ev::toBool(v);
}

std::string strProp(bronze::Value obj, const char* key,
                    const std::string& fallback) {
    namespace ev = bronze::embed;
    if (!ev::isObject(obj)) return fallback;
    bronze::Value v = ev::getProperty(obj, key);
    if (ev::isString(v)) {
        return ev::toUtf8(v);
    }
    return fallback;
}

uint32_t arrayLength(bronze::Value arr) {
    namespace ev = bronze::embed;
    if (!ev::isObject(arr)) return 0;
    bronze::Value lenVal = ev::getProperty(arr, "length");
    if (!ev::isNumber(lenVal)) return 0;
    double d = ev::toDouble(lenVal);
    if (d < 0.0 || std::isnan(d)) return 0;
    return static_cast<uint32_t>(d);
}

bool takeName(bronze::Value v, std::string* out) {
    namespace ev = bronze::embed;
    if (!ev::isString(v)) return false;
    if (out) *out = ev::toUtf8(v);
    return true;
}

bronze::Value stringsToJs(const std::vector<std::string>& v) {
    namespace ev = bronze::embed;
    ev::CallResult parsed = ev::parseJson("[]");
    ev::Persistent arr{parsed.value};
    for (uint32_t i = 0; i < v.size(); ++i) {
        ev::Persistent s{ev::fromUtf8(v[i])};
        arr.set(ev::setElement(arr.get(), i, s.get()));
    }
    return arr.get();
}

bronze::Value intsToJs(const std::vector<int>& v) {
    namespace ev = bronze::embed;
    ev::CallResult parsed = ev::parseJson("[]");
    ev::Persistent arr{parsed.value};
    for (uint32_t i = 0; i < v.size(); ++i) {
        arr.set(ev::setElement(arr.get(), i, ev::fromDouble(v[i])));
    }
    return arr.get();
}

bronze::Value channelsToJs(const std::vector<ChannelLevel>& v) {
    namespace ev = bronze::embed;
    ev::CallResult parsed = ev::parseJson("[]");
    ev::Persistent arr{parsed.value};
    for (uint32_t i = 0; i < v.size(); ++i) {
        ev::Persistent o{ev::createObject()};
        ev::Persistent nameStr{ev::fromUtf8(v[i].name)};
        o.set(ev::setProperty(o.get(), "name", nameStr.get()));
        o.set(ev::setProperty(o.get(), "truePeak", ev::fromDouble(v[i].truePeak)));
        o.set(ev::setProperty(o.get(), "peak", ev::fromDouble(v[i].peak)));
        o.set(ev::setProperty(o.get(), "rms", ev::fromDouble(v[i].rms)));
        arr.set(ev::setElement(arr.get(), i, o.get()));
    }
    return arr.get();
}

bronze::Value channelsToJs(const std::vector<float>& v) {
    namespace ev = bronze::embed;
    bronze::Value ta = ev::createTypedArray(ev::elements::Float32, static_cast<uint32_t>(v.size()));
    if (!v.empty()) {
        std::span<const uint8_t> bytes(reinterpret_cast<const uint8_t*>(v.data()), v.size() * sizeof(float));
        ev::fillTypedArray(ta, bytes);
    }
    return ta;
}

} // namespace ffmpegbro
