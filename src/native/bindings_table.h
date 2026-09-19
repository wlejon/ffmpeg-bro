// A table of functions hung off another object: `bro.ffmpeg`, and `render`,
// `record`, `live`, `inputs`, `views` and `output` inside it.
//
// This is the bronze-backed Table class wrapping bronze::Value.
// It attaches properties, subtables, and functions onto an object.
#pragma once

#include <embed/embed.h>
#include <embed/embed_handle.h>

#include <functional>
#include <span>
#include <string>
#include <string_view>
#include <utility>

namespace ffmpegbro {

/// One part of `bro.ffmpeg`: Table wrapping a bronze::Value object, providing
/// subtable creation, native function registration, and property assignment.
class Table {
public:
    Table() : obj_(bronze::embed::createObject()) {}

    explicit Table(bronze::Value obj) : obj_(obj) {}

    Table(bronze::Value parent, const char* name) {
        namespace ev = bronze::embed;
        bronze::Value child = ev::getProperty(parent, name);
        if (!ev::isObject(child)) {
            ev::Persistent created(ev::createObject());
            ev::setProperty(parent, name, created.get());
            child = created.get();
        }
        obj_.set(child);
    }

    Table(Table& parent, const char* name) : Table(parent.value(), name) {}

    bronze::Value value() const { return obj_.get(); }

    Table subtable(const char* name) {
        namespace ev = bronze::embed;
        bronze::Value child = ev::getProperty(obj_.get(), name);
        if (!ev::isObject(child)) {
            ev::Persistent created(ev::createObject());
            obj_.set(ev::setProperty(obj_.get(), name, created.get()));
            child = created.get();
        }
        return Table(child);
    }

    Table& function(const char* name, int arity,
                    std::function<bronze::Value(bronze::Value thisVal, std::span<const bronze::Value> args)> fn) {
        namespace ev = bronze::embed;
        bronze::Value fnVal = ev::makeFunction(std::move(fn), static_cast<uint32_t>(arity), name);
        obj_.set(ev::setProperty(obj_.get(), name, fnVal));
        return *this;
    }

    Table& function(const char* name,
                    std::function<bronze::Value(bronze::Value thisVal, std::span<const bronze::Value> args)> fn,
                    int arity = 0) {
        return function(name, arity, std::move(fn));
    }

    Table& value(const char* name, bronze::Value v) {
        namespace ev = bronze::embed;
        obj_.set(ev::setProperty(obj_.get(), name, v));
        return *this;
    }

    Table& value(const char* name, bool b) {
        namespace ev = bronze::embed;
        return value(name, ev::fromBool(b));
    }

    Table& value(const char* name, double d) {
        namespace ev = bronze::embed;
        return value(name, ev::fromDouble(d));
    }

    Table& value(const char* name, int n) {
        namespace ev = bronze::embed;
        return value(name, ev::fromDouble(n));
    }

    Table& value(const char* name, const std::string& s) {
        namespace ev = bronze::embed;
        return value(name, ev::fromUtf8(s));
    }

    Table& value(const char* name, const char* s) {
        namespace ev = bronze::embed;
        return value(name, s ? ev::fromUtf8(s) : ev::null());
    }

private:
    bronze::embed::Persistent obj_;
};

} // namespace ffmpegbro
