// A table of functions hung off another object: `bro.ffmpeg`, and `render`,
// `record`, `live`, `inputs`, `views` and `output` inside it.
//
// This is qjsbind's `Namespace` under a name that says what one of these is.
// The only thing this surface needed that a namespace did not do was the
// parent — a namespace attached itself to `globalThis`, and `bro.ffmpeg` is two
// levels down, because bro owns `bro` and half the calls sit in a table of
// their own inside `ffmpeg`. That is a parameter of `Namespace` now, so what
// was a reimplementation of the builder against qjsbind's internals is a name
// for the builder.
//
// Registration is therefore all qjsbind's: the RAII attach, the trampolines,
// `Convert<T>` on every argument and return, and one callable per registration
// owned by the function object that calls it — so a helper may register several
// calls from one lambda expression, which is what `optionTable` in
// bindings_capabilities.cpp does.
//
// A call that reads a whole spec keeps QuickJS's own signature and is
// registered with the raw overload. There is nothing for `Convert<T>` to do
// with a render spec, and `(ctx, this, argc, argv)` states plainly that the
// reading is the function's own business.
#pragma once

#include <qjsbind/qjsbind.h>

namespace ffmpegbro {

/// One part of `bro.ffmpeg`: `Table(ctx, parent, name)` for a table on a
/// borrowed object, `Table(parent, name)` for one inside another table. The
/// property is set when the table goes out of scope, which is what makes the
/// whole surface one nest of scopes.
///
/// A missing argument arrives as `undefined` and converts like one, so a lambda
/// taking `JSValue` is the way to insist on a type — which is what `takeName`
/// in bindings_value.h is for.
using Table = qjsbind::Namespace;

} // namespace ffmpegbro
