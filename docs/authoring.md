# Authoring TikZ

High level only. Nothing here is decided in detail, and nothing is built yet.

## Where this is going

The extension currently highlights a figure and hands the build off to your scripts. The authoring side is the rest of it: help writing the figure, not just colouring it.

The end goal is that you choose the effect you want and the interface writes the syntax for it. Paths and how they are drawn, nodes, scopes, styles, transformations, children and trees, pics, matrices, plots, `foreach`: each of those is a candidate, and the reference card below is organised by those same groups.

Every construct has the same two halves: a set of options with values, and some literal syntax to get right. So the interface is one mechanism applied repeatedly — invoke it on a construct in the document, or on the spot where one should go, get controls for what that construct accepts, and have the edit written back in place. Opening it on something already written reads the current values out.

The node is the first one to build, because it is the densest and the most used, and because it exercises every hard part at once: options with enumerated values, a coordinate, and literal text.

Completion is the smaller, earlier version of the same idea: the same vocabulary, offered as you type rather than as a form.

## The model: a visual reference card

Alan Cain's TikZ Reference Card (v0.4.2, 2016) is the thing this should automate. It stays in use because it is visual, and that is the flavour the panel should have.

Look at what it actually does. Line widths are not listed, they are _drawn_ — `ultra thin` through `ultra thick` each shown as a line of that width. Dash patterns are drawn. Opacity is a ramp of grey circles. Plot marks are drawn. Transformations are little sheared boxes. Miter and bevel joins are drawn as black shapes. Nothing there asks you to imagine the result.

Two panels are the whole argument. The node anchor diagram puts every anchor at its real position on a labelled box, so you pick `mid east` by pointing at where it is. The `pos=` scale draws a line with `at start`, `near start`, `midway`, `near end`, `at end` marked against 0 to 1. Neither requires remembering a name.

So the panel is not a list of key names with text fields beside them. Wherever a value has a visual, the visual is the control: an anchor grid, line-width swatches, a dash gallery, an opacity ramp, a `pos` slider. Where a value genuinely has no picture — a node name, a length, a piece of text — a plain field is right.

The card is a model, not a source. Its pictures are static, drawn once; ours have to be live and generated from the vocabulary, so that a key added later gets a control without anyone redrawing anything.

It is also worth reading for the parts we have not enumerated. Its coordinate block lists `+⟨coord⟩` against `++⟨coord⟩`, the `cs` forms, and the calc variants split into position, distance and project — the checklist for the helper above. And it marks in the margin which library a key needs, which is the scoping problem, solved by hand, one more time.

## Why the vocabulary comes first

Both halves need one thing: which keys a node accepts, and which values each key takes. Completion needs it to offer `anchor=` and then `north`. The panel needs it to know which fields to draw at all. So the vocabulary is built once and serves both, and it is the first thing to get right.

## The data

Start with `tikz.cwl`, the completion word list the LaTeX editors already maintain. It is curated, scoped per package, and already carries the key and value information — `anchor` with its list of anchors, and so on. Prefer it over generating our own table from the pgf sources: a generated list spans every pgf library at once, so it offers circuit-diagram and data-visualisation keys in a figure that loads neither, and separating them is work that a hand-curated file has already done.

If something turns out to be missing from the cwl, add it by hand on top. A small local supplement is cheaper than owning a generator, and can stay small.

## Coordinates

Two syntaxes, for two different kinds of arithmetic, and remembering which is which is exactly the tedium the interface should absorb.

`($(bbus)+(0,1.5mm)$)` is the calc library: arithmetic on _points_. Adding one coordinate to another, the partway `!` operator, projections. The dollars are what mark the parenthesised thing as an expression over coordinates rather than as a coordinate.

`({(\xLoss+\xR)/2},{-\dy/2})` is not calc at all. It is an ordinary `(x,y)` whose _components_ are pgfmath expressions. The braces are there because a component holding a comma or a parenthesis would otherwise confuse the coordinate parser: `(\xLoss+\xR)/2` contains parentheses, so it has to be braced. `-\dy/2` does not strictly need them.

Within calc, the partway operator is its own small language. `($(\xF,\ext)!0.5!(bbend)$)` is the point halfway between the two, and the variants change what the middle term means: a fraction walks that proportion of the way, a length like `!5mm!` walks a fixed distance instead, an angle as in `!0.5!90:` turns at the point it reaches, and a coordinate in the middle — `($(a)!(c)!(b)$)` — projects `c` onto the line from `a` to `b`.

Those are four genuinely different operations wearing one punctuation mark, which is the strongest argument in this file for the panel. Offer them by intent — halfway between, a distance along, perpendicular from, projected onto — and let the interface write the `!` and the `:`.

There is more than this, and it is not enumerated yet. Relative coordinates are a separate trap of the same kind: `+(1,0)` and `++(1,0)` differ only in whether the current point moves afterwards. Beyond those sit the coordinate systems, written `(<name> cs: ...)` — `tangent` from calc, `polar` behind the `(30:2cm)` shorthand, `node` behind `(a.north)`, `perpendicular` behind `(a |- b)`, and intersections — plus `let ... in` for naming an intermediate result and reusing it.

Enumerating that properly is a job for when the helper is built, against the manual rather than from memory. What matters for the plan is the shape: a handful of unrelated syntaxes, each with its own punctuation, all expressing things a person thinks of in one or two words. Every one of them is a candidate for the same treatment — say the intent, let the interface write the syntax.

The rule, then: operating on points is calc; operating on numbers inside one point is a braced component. Which is a rule nobody should have to hold in their head while drawing.

So the helper takes what you mean and supplies the wrapper — the `$ $`, the `{ }`, the parentheses. It should also read an existing coordinate the other way, so the panel can tell you which of the two you are looking at, and so it can be opened on a coordinate someone else wrote.

The grammar already tells the two apart, which is the groundwork. Coordinates appear in most constructs, not just nodes, so the helper is shared from the start; the node's placement field is simply its first consumer.

## What is already here

`StyleIndex` indexes `/.style` names across the whole workspace. Those are the keys no external file can ever know — `arg`, `sym`, `flow` — and they belong in the same completion list and the same panel as the built-in ones.

`symbols.js` already finds macro definitions, `\def` included, which is more than the general-purpose LaTeX tooling manages. Not a priority: the maths in a figure is thin.

## Order of work

1. Vocabulary — read `tikz.cwl` into a key and value table.
2. Completion — keys inside `[...]`, values after `=`, plus the workspace styles.
3. Coordinate helper — the wrapper rules above, both directions.
4. First panel, on the node — a form over the vocabulary and the helper, reading and rewriting one construct in place, with a visual control wherever the value has a picture. Then the same mechanism for the next construct.

Each step is useful on its own, and each one is the groundwork for the next.

## Non-goals

Not a LaTeX toolchain. No build recipes, no PDF viewer, no build on save. `F6` and `F7` hand off to the project's own scripts on purpose, because only the project knows what a figure compiles against. Nothing here may drag a build system in behind it.
