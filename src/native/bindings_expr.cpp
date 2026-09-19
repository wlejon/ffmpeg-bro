// `bro.ffmpeg.expr` — libavutil's own expression evaluator, asked directly.
//
// ffmpeg has no interpolation in its timeline support: `enable` turns a filter
// on and off and nothing ramps a value. What it has instead is **expressions in
// a filter's own options**, re-read per frame — `crop`'s `x`, `overlay`'s,
// `rotate`'s angle, `volume`'s gain — and those have always worked here, because
// an option is a string and `ui/graph/print.js` writes a string verbatim. What
// was missing was any way to *see* one: a curve on the screen saying what the
// value does over the render.
//
// **The curve is libav's own arithmetic and nothing else.** A second evaluator
// in JavaScript would draw a shape the render does not perform, and it would
// differ on exactly the cases somebody reaches for an expression to get:
// integer division, `between`, `lt`, `mod`, `clip`'s rounding at the ends. So
// this is `av_expr_parse` and `av_expr_eval`, which is the same pair
// `export_writer.cpp` already uses for `-force_key_frames expr:` and the same
// pair libavfilter calls on the option itself. Proved rather than assumed:
// `crop=x='lerp(0,160,clip(t/2,0,1))'` on a 320×240 `testsrc` produces, at
// t=1.0, a frame byte-identical to `crop=x=80` — the value this evaluator gives
// for that expression at that instant.
//
// ── The hard part: which variables are in scope ────────────────────────────
//
// `av_expr_parse` wants the variable names up front, and a name it was not given
// fails the parse. **libav offers no way to ask a filter which names it takes.**
// They are `static const char *const var_names[]` in each filter's own C file —
// not in the AVOption table, not on the AVFilter, not reachable through
// `avfilter_get_by_name`. `av_expr_count_vars` is the nearest thing and answers
// a different question: which of the names *you supplied* actually occur. There
// is no `av_expr_list_vars`, and `libavutil/eval.h` is the whole of the API.
//
// So the names are the caller's to supply — `ui/graph/expr.js` is the one home
// for the set this application knows, with the note saying where it came from
// and that it is not complete — and this call's job is to be exact about what
// happened:
//
//   - it parsed, and here is which of your names it uses (`uses`);
//   - it did not parse, and **here are the words libav does not know**.
//
// That second half is the one worth explaining. A parse failure comes back as
// AVERROR(EINVAL) with the offending token only in a log line, so naming it
// means finding it — and finding it must not become a second parser, because a
// second parser is the thing this file exists to avoid. What it does instead is
// scan for identifier-shaped runs (a lexical fact, not a grammar) and then **ask
// libav about each one on its own**: parse `zoom`, or `foo(0)` for a token used
// as a call. libav remains the authority on every judgement; the scan only
// decides which strings to ask about. A token libav accepts alone is a variable
// it was given or one of its own constants (`PI`, `E`, `PHI`), and is not the
// problem; a token it refuses alone is named back to the caller.

#include "bindings_install.h"

#include "bindings_table.h"
#include "bindings_value.h"

extern "C" {
#include <libavutil/error.h>
#include <libavutil/eval.h>
}

#include <embed/embed.h>

#include <algorithm>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

/// How many samples one call will evaluate. A curve across a two-hundred-pixel
/// column wants a hundred and change; anything past this is a caller that has
/// mistaken this for a render loop, and the answer would be a JS array of a
/// million doubles built one by one.
constexpr uint32_t kMaxRows = 4096;

/// And how many variables. libav has no limit; this one is here so that a
/// malformed `names` array cannot make `std::vector<double>` the size of the
/// heap before the parse ever runs.
constexpr uint32_t kMaxNames = 64;

/// Is this character allowed in one of ffmpeg's identifiers?
///
/// A lexical question and deliberately nothing more — see the note at the top:
/// this decides which substrings to *ask libav about*, and libav decides
/// everything else. ffmpeg's own lexer takes letters, digits and underscore, and
/// its variable names run to `main_w`, `overlay_h`, `n_forced` and `prev_forced_t`.
bool identChar(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
           c == '_';
}

bool identStart(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
}

/// Every identifier-shaped run in the text, each with whether it is followed by
/// `(` — which is what tells a function from a variable, and is the only thing
/// this scan concludes on its own.
struct Word {
    std::string text;
    bool called = false;
};

std::vector<Word> wordsIn(const std::string& s) {
    std::vector<Word> out;
    size_t i = 0;
    while (i < s.size()) {
        if (!identStart(s[i])) { ++i; continue; }
        const size_t start = i;
        while (i < s.size() && identChar(s[i])) ++i;
        Word w;
        w.text = s.substr(start, i - start);
        size_t j = i;
        while (j < s.size() && (s[j] == ' ' || s[j] == '\t')) ++j;
        w.called = j < s.size() && s[j] == '(';
        // A number's exponent — `1e6`, `2E-3` — is not an identifier and would
        // be reported as an unknown word every time somebody wrote one.
        // Recognised by what precedes it, which is the only thing that tells
        // `1e6` from `x*e6`.
        const bool afterDigit = start > 0 && (s[start - 1] >= '0' && s[start - 1] <= '9');
        if (afterDigit && (w.text[0] == 'e' || w.text[0] == 'E')) continue;
        if (std::none_of(out.begin(), out.end(),
                         [&](const Word& p) { return p.text == w.text && p.called == w.called; }))
            out.push_back(std::move(w));
    }
    return out;
}

/// Does libav know this word, on its own, used the way the text uses it?
///
/// The one judgement in this file that is not libav's is which string to hand
/// over; this is where it hands one over. A call is tried at one, two and three
/// arguments because that is the whole of what `av_expr_parse` supports and
/// there is no way to ask a builtin its arity either.
bool libavKnows(const Word& w, const char* const* names) {
    const std::vector<std::string> tries =
        w.called ? std::vector<std::string>{w.text + "(0)", w.text + "(0,0)",
                                            w.text + "(0,0,0)"}
                 : std::vector<std::string>{w.text};
    for (const auto& probe : tries) {
        AVExpr* e = nullptr;
        // AV_LOG_ERROR + 64 puts every complaint from these probes past
        // AV_LOG_QUIET, so a panel drawing a curve does not fill the Report
        // drawer with "Undefined constant" about words it is only asking after.
        const int rc = av_expr_parse(&e, probe.c_str(), names, nullptr, nullptr, nullptr,
                                     nullptr, 64, nullptr);
        if (e) av_expr_free(e);
        if (rc >= 0) return true;
    }
    return false;
}

/// A JS array of strings → the NUL-terminated `const char* const*` libav wants.
///
/// The strings are owned by `store` and the pointer array by `ptrs`, both of
/// which must outlive every use: `av_expr_parse` keeps no copy of the names but
/// does compare against them while parsing.
bool takeNames(bronze::Value arr, std::vector<std::string>* store,
               std::vector<const char*>* ptrs) {
    namespace ev = bronze::embed;
    if (ev::isUndefined(arr) || ev::isNull(arr)) { ptrs->push_back(nullptr); return true; }
    if (!isArray(arr)) return false;
    const uint32_t n = std::min(arrayLength(arr), kMaxNames);
    store->reserve(n);
    for (uint32_t i = 0; i < n; i++) {
        bronze::Value v = ev::getElement(arr, i);
        if (!ev::isString(v)) return false;
        store->push_back(ev::toUtf8(v));
    }
    ptrs->reserve(store->size() + 1);
    for (const auto& s : *store) ptrs->push_back(s.c_str());
    ptrs->push_back(nullptr);
    return true;
}

/// `{ ok: false, reason, unknown: [...] }` — a refusal with libav's verdict on
/// every word in it. `unknown` empty means the expression is malformed rather
/// than short of a name, which is a different thing to say to somebody.
bronze::Value refusal(const std::string& text, const char* const* names) {
    namespace ev = bronze::embed;
    ev::Persistent out(ev::createObject());
    setBool(out.get(), "ok", false);
    std::vector<std::string> unknown;
    for (const auto& w : wordsIn(text))
        if (!libavKnows(w, names)) unknown.push_back(w.text);
    ev::Persistent unk(stringsToJs(unknown));
    out.set(ev::setProperty(out.get(), "unknown", unk.get()));

    std::string reason;
    if (unknown.empty()) {
        reason = "libav's evaluator will not parse this";
    } else if (unknown.size() == 1) {
        reason = "libav's evaluator does not know " + unknown[0] + " here";
    } else {
        reason = "libav's evaluator does not know these here: ";
        for (size_t i = 0; i < unknown.size(); i++) reason += (i ? ", " : "") + unknown[i];
    }
    setStr(out.get(), "reason", reason);
    return out.get();
}

} // namespace

void installExpression(Table& ns) {
    Table expr(ns, "expr");

    /// bro.ffmpeg.expr.evaluate(text, names, rows)
    ///
    /// One parse and one `av_expr_eval` per row. `names` is the variables the
    /// caller is prepared to name — see the file's note on why that cannot be
    /// asked of the filter — and `rows` is one array of values per name, one
    /// row per sample. `rows` may be empty, which is how a caller asks the
    /// question "is this an expression at all, and what does it use" without
    /// wanting a curve.
    ///
    /// Answers `{ ok: true, uses, values }` or `{ ok: false, reason, unknown }`.
    /// **`uses` is `av_expr_count_vars`**, not a scan: it is the only way to
    /// know that `crop`'s `x` is a constant rather than an animation without
    /// re-implementing the grammar, and a strip drawn for a value that never
    /// moves is a strip on every option in the table.
    ///
    /// Not a throw, because "this string is not an expression" is the ordinary
    /// answer for most of a filter's options — `drawtext`'s `fontfile` is a
    /// path — and a caller asking about each option in turn would be a caller
    /// wrapped in try/catch.
    expr.function("evaluate", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        std::string text;
        if (args.empty() || !takeName(args[0], &text))
            return ev::throwTypeError("expr.evaluate(text, names, rows) requires text");

        bronze::Value namesArg = args.size() >= 2 ? args[1] : ev::undefined();
        bronze::Value rowsArg = args.size() >= 3 ? args[2] : ev::undefined();

        std::vector<std::string> nameStore;
        std::vector<const char*> names;
        if (!takeNames(namesArg, &nameStore, &names))
            return ev::throwTypeError("expr.evaluate(text, names, rows) requires an array of "
                                      "variable names");

        AVExpr* parsed = nullptr;
        // Silenced for the same reason the probes above are: an option being
        // looked at is not a render going wrong, and libav logs a parse failure
        // at AV_LOG_ERROR either way.
        const int rc = av_expr_parse(&parsed, text.c_str(), names.data(), nullptr, nullptr,
                                     nullptr, nullptr, 64, nullptr);
        if (rc < 0 || !parsed) {
            if (parsed) av_expr_free(parsed);
            return refusal(text, names.data());
        }
        const std::unique_ptr<AVExpr, void (*)(AVExpr*)> owned(parsed, av_expr_free);

        ev::Persistent out(ev::createObject());
        setBool(out.get(), "ok", true);

        // Which of the supplied names actually occur. libav counts into an
        // array indexed the same way `names` is, so an empty name list is an
        // expression of constants and the loop below simply does not run.
        std::vector<unsigned> counts(nameStore.size(), 0u);
        std::vector<std::string> uses;
        if (!counts.empty() &&
            av_expr_count_vars(parsed, counts.data(), static_cast<int>(counts.size())) >= 0)
            for (size_t i = 0; i < counts.size(); i++)
                if (counts[i]) uses.push_back(nameStore[i]);
        ev::Persistent usesVal(stringsToJs(uses));
        out.set(ev::setProperty(out.get(), "uses", usesVal.get()));

        ev::Persistent values(createArray());
        if (isArray(rowsArg)) {
            ev::Persistent rowsP(rowsArg);
            const uint32_t rows = std::min(arrayLength(rowsP.get()), kMaxRows);
            std::vector<double> vars(nameStore.size(), 0.0);
            for (uint32_t r = 0; r < rows; r++) {
                bronze::Value row = ev::getElement(rowsP.get(), r);
                std::fill(vars.begin(), vars.end(), 0.0);
                if (isArray(row)) {
                    ev::Persistent rowP(row);
                    const uint32_t n =
                        std::min<uint32_t>(arrayLength(rowP.get()),
                                           static_cast<uint32_t>(vars.size()));
                    for (uint32_t i = 0; i < n; i++) {
                        bronze::Value cell = ev::getElement(rowP.get(), i);
                        double d = 0.0;
                        // A cell that is not a number stays zero rather than
                        // becoming NaN — the same rule `bindings_value.h` gives
                        // its two reasons for, and here it is the difference
                        // between one bad sample and a whole curve of NaN.
                        if (ev::isNumber(cell)) {
                            d = ev::toDouble(cell);
                            if (d == d) vars[i] = d;
                        }
                    }
                }
                const double v = av_expr_eval(parsed, vars.data(), nullptr);
                // NaN and ±inf are what an expression divided by zero comes to,
                // and JSON has no spelling for either — so they arrive as null,
                // which a caller draws as a gap rather than as a number.
                bronze::Value cellVal = (v == v && v > -1e308 && v < 1e308) ? ev::fromDouble(v)
                                                                             : ev::null();
                values.set(ev::setElement(values.get(), r, cellVal));
            }
        }
        out.set(ev::setProperty(out.get(), "values", values.get()));
        return out.get();
    }, 3);
}

} // namespace ffmpegbro
