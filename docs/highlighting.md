# How the highlighting works

Notes on the internals, for changing the colouring or working out why some construct comes out wrong. Nothing here is needed to _use_ the extension — see the README for that.

**TextMate** is a macOS editor from 2004 whose syntax-highlighting format outlived it. Sublime Text, Atom and VS Code all adopted it, and it is still how VS Code colours very nearly every language it ships. So "TextMate grammar" names a file format, not an editor you have to install — nothing here needs TextMate itself.

**A TextMate grammar** is a JSON file listing rules. Each rule is a regular expression plus a _scope_: a dotted name like `constant.numeric.dimension.tikz`. The grammar's whole job is to walk the text and attach a scope to every span. It is not a parser. Nothing in it understands LaTeX, or knows that `\draw` takes a path and ends at a semicolon — it matches text and labels it, and that is all.

Themes map scopes to colours, the longest matching prefix winning, so a theme with a rule for `constant.numeric` colours the dimension above without ever having heard of TikZ. That is why no palette ships with this extension: the grammar says what a thing _is_ and the theme decides what colour that is. `settings-snippet.jsonc` only fills the gaps where a theme leaves one of these scopes the colour of ordinary text.

## Rules

Regular expressions are the engine, but a grammar is not one big regex — it is a stack machine over many small ones, in the [Oniguruma](https://github.com/kkos/oniguruma) flavour, the same one Ruby uses. There are two rule shapes:

- A **`match`** rule is one regex and a scope. `#dimension` is one: match `-1.5mm`, call it a dimension.
- A **`begin`/`end`** rule is _two_ regexes marking the start and end of a region, plus a list of child patterns that apply only inside it. This is the part plain regex cannot do: it gives you nesting and state. `#maths` is one — open on `$`, close on the next `$`, and scope everything between as one flat string.

At each position the engine tries every active pattern and takes the **earliest match in the text**, not the first rule in the list; only a tie is settled by listing order. Much of this grammar is therefore about ordering. `#dimension` is listed before `#calc-operator` so the sign in `(-1mm,-1.5mm)` stays attached to its number instead of being read as subtraction, and `#bare-option` is last so anything with more structure has already been claimed.

## Injection

This grammar does not own `.tex` files — VS Code's stock LaTeX grammar does. Ours is an _injection_: an `injectionSelector` names the scope it wants to be spliced into, and the `L:` prefix means left priority, so our rules get first refusal ahead of the host's. `syntaxes/tikz-injection.tmLanguage.json` selects `meta.function.environment.latex.tikz`, which is the host's own name for a `tikzpicture` body, so the TikZ rules exist only inside a picture. `syntaxes/tikz-toplevel.tmLanguage.json` covers the TikZ that lives outside one: `\tikzset{...}` in a preamble, and `\tikz ...;` one-liners.

The negations at the end of the selector are load-bearing, and one of them is a trap worth knowing about. An injection re-applies wherever its selector still matches — _including_ inside a region this grammar itself opened, because the scope stack in there still says "tikzpicture". Without a negation, `#maths` gets injected back into our own `begin`/`end` blocks, where it can match a `$` before the block's `end` regex does and run the rest of the line into a string. Each such region therefore carries a scope of its own that the selector excludes: maths is `string...`, matched by `-string`, and a `calc` coordinate is `meta.coordinate.calc.tikz`, matched by `-meta.coordinate.calc.tikz`.

The same effect is why there is no rule marking `{` and `}` at path level: an `L:` injection outruns the _host's_ end patterns too, so a bare `}` rule steals the closing brace of constructs like `\textbf{...}` and leaves them open for the rest of the file.

## `.tikz` files

A figure kept in a file of its own is picture body from the first line: the `\begin{tikzpicture}` sits in the parent that `\input`s it. Nothing establishes the scope the injection keys on, so a fragment cannot be highlighted as a `.tex` file is. `.tikz` is therefore a language in its own right, and `syntaxes/tikz-file.tmLanguage.json` is its grammar. That grammar carries no rules of its own: a fragment is still LaTeX, so it includes the stock LaTeX grammar and leaves the TikZ to the same two injections, which reach it through its root scope name.

That name, `text.tex.latex.tikz-file`, is what stands in for the missing `tikzpicture`, and it is read at both ends. `tikz-injection` names it in a second clause of its selector, and that is what puts the path rules over the whole file. Scope selectors also match by dotted prefix, so a name beginning `text.tex.latex` is already matched by `tikz-toplevel`'s selector — `\tikzset{...}` at the head of a fragment colours as it does in a preamble — and by any theme rule written for LaTeX.

Both tokenising tools take the root grammar from the file's extension, so pointing them at a `.tikz` file shows what the editor shows.

## What a grammar cannot do

Regexes have no memory of the rest of the file, so anything that needs to _know_ something cannot live here. `\def`'ed macros and `/.style` names are the two cases that matter, and they are handled by a semantic token provider instead (`src/semantic.js`), which scans the document and the workspace and reports `tikzMacro` and `tikzStyle` for names it can prove were defined. That is the half of the highlighting that needs `editor.semanticTokenColorCustomizations.enabled`.

## Checking a change

Two tools run the real VS Code TextMate engine, so what they print is exactly what the editor produces:

```sh
./tools/tm tools/tokenize.mjs <file.tex>     # every token and its scopes
./tools/tm tools/audit.mjs <file.tex>...     # sweep a corpus for runaway blocks
```

`audit.mjs` catches the main way a grammar like this goes wrong: a `begin`/`end` rule whose end never matches swallows the rest of the file. Point it at a few hundred real figures after any change to a `begin`/`end` rule.

`./tools/test` holds the grammar to what it produced last: every fixture in `test/` is tokenised and compared with the `.scopes` file beside it. Only the scopes this grammar assigns are recorded, merged over runs of text, so a new VS Code fails it only where it changes TikZ highlighting, not where the stock LaTeX grammar merely splits its tokens differently. After a deliberate change, re-record with `./tools/tm tools/test-grammar.mjs --update` and read the diff of the `.scopes` files: that diff is the change, as the editor will show it.

`.github/workflows/release.yml` runs `./tools/test` on every push against the newest VS Code Stable, which gates the release, and the grammar half again against the newest Insiders, which only warns: Stable is what people run today, Insiders what they will run next. `./tools/fetch-vscode stable|insider` downloads either for a local run, and prints the folder to point `VSCODE` at.

`test/spacing.tex` is the regression case for the spacing rule, and its first node is the control: spacing _inside_ a formula must stay part of the one flat string, which the `-string` negation is what guarantees.

`test/calc.tex` is the regression case for calc coordinates: every dollar in it is a delimiter, and the last lines are the control — real maths, which must still come out as `string.other.math.tikz`.
