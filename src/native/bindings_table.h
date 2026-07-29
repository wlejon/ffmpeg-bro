// A table of functions hung off another object: `bro.ffmpeg`, and `render`,
// `record`, `live`, `inputs`, `views` and `output` inside it.
//
// This is qjsbind's `Namespace` with the one thing it does not do. qjsbind
// attaches a namespace to `globalThis` in its destructor, and this surface is
// two levels down — bro owns `bro`, this binary adds `ffmpeg` to it, and half
// the calls sit in a table of their own inside that. So the parent is a
// parameter here. Everything underneath is qjsbind's: the same RAII attach, the
// same trampolines, the same `Convert<T>` on every argument and return.
//
// **A closure's type is its storage, so register lambdas and only lambdas.**
// qjsbind keeps each registered function in a static slot keyed on the
// closure's type. Every lambda *expression* has a type of its own, so that is
// one slot each — but two functions of the same signature share one, and a
// helper that registered several functions from a single lambda expression
// would leave all of them calling whichever was registered last. Both mistakes
// are silent at runtime and neither is obvious in a diff, so `function()`
// refuses anything that is not a closure, and a helper that wraps several
// registrations takes the thing it wraps as a *template* argument to get a
// closure type per instantiation (see `optionTable` in
// bindings_capabilities.cpp).
//
// A call that reads a whole spec keeps QuickJS's own signature and is
// registered with the raw overload. There is nothing for `Convert<T>` to do
// with a render spec, and `(ctx, this, argc, argv)` states plainly that the
// reading is the function's own business.
#pragma once

#include <quickjs.h>

#include <qjsbind/qjsbind.h>

#include <type_traits>

namespace ffmpegbro {

class Table {
public:
    /// A table to be hung on `parent` under `name`. `parent` is borrowed — the
    /// caller keeps its reference — and the property is set when this goes out
    /// of scope, which is what makes the whole surface one nest of scopes.
    Table(JSContext* ctx, JSValue parent, const char* name)
        : ctx_(ctx), parent_(parent), name_(name), obj_(JS_NewObject(ctx)) {}

    /// A table inside another table.
    Table(Table& parent, const char* name)
        : Table(parent.ctx_, parent.obj_, name) {}

    ~Table() { JS_SetPropertyStr(ctx_, parent_, name_, obj_); }

    Table(const Table&) = delete;
    Table& operator=(const Table&) = delete;
    Table(Table&&) = delete;
    Table& operator=(Table&&) = delete;

    /// A call whose arguments qjsbind converts:
    /// `.function("name", [](JSContext* ctx, std::string n) { … })`. A missing
    /// argument arrives as `undefined` and converts like one, so a lambda taking
    /// `JSValue` is the way to insist on a type — which is what `takeName` is
    /// for.
    template <typename Fn>
        requires(!std::is_convertible_v<std::decay_t<Fn>, JSCFunction*>)
    Table& function(const char* name, Fn&& fn) {
        static_assert(std::is_class_v<std::decay_t<Fn>>,
                      "register a lambda expression, not a function pointer: two "
                      "functions of the same signature would share one slot and "
                      "the second registration would win both");
        using Caller = qjsbind::detail::StaticCaller<void, std::decay_t<Fn>>;
        qjsbind::detail::FnStore<std::decay_t<Fn>>::fn.emplace(std::forward<Fn>(fn));
        JS_SetPropertyStr(
            ctx_, obj_, name,
            JS_NewCFunction(ctx_,
                            &qjsbind::detail::static_trampoline<void, std::decay_t<Fn>>,
                            name, static_cast<int>(Caller::js_argc)));
        return *this;
    }

    /// A call that does its own argument reading.
    Table& function(const char* name, JSCFunction* fn, int length = 0) {
        JS_SetPropertyStr(ctx_, obj_, name, JS_NewCFunction(ctx_, fn, name, length));
        return *this;
    }

    /// A property. Consumes the reference, as `JS_SetPropertyStr` does.
    Table& value(const char* name, JSValue v) {
        JS_SetPropertyStr(ctx_, obj_, name, v);
        return *this;
    }

    /// A property from a C++ value, converted by qjsbind.
    template <typename V>
        requires(!std::is_same_v<std::decay_t<V>, JSValue>)
    Table& value(const char* name, V v) {
        JS_SetPropertyStr(ctx_, obj_, name, qjsbind::Convert<V>::to_js(ctx_, v));
        return *this;
    }

    JSContext* context() const { return ctx_; }
    JSValue object() const { return obj_; }

private:
    JSContext* ctx_;
    JSValue parent_;
    const char* name_;
    JSValue obj_;
};

} // namespace ffmpegbro
