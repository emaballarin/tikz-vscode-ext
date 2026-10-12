#!/bin/sh
# Preview one TikZ figure.
#
# "TikZ: Build and report" passes the figure's path as $1 and runs this from the folder
# it found the script in. The last line it writes to build/.build-status is what the
# editor shows in its notification.
set -e

# The one line to change: your document's preamble, so a figure looks here as it will
# in the document.
preamble="$PWD/preamble.tex"

# A .tikz file is picture body alone, its \begin{tikzpicture} being in the document that
# inputs it -- unless it was written with one, as tikzplotlib writes them. Only a bare body
# is wrapped. A .tex figure is input as it stands, whatever environment it draws in.
figure="\\input{$1}"
case "$1" in
  *.tikz)
    if ! grep -q '^[^%]*\\begin{tikzpicture}' "$1"; then
      figure="\\begin{tikzpicture}
$figure
\\end{tikzpicture}"
    fi
    ;;
esac
name=$(basename "$1")
name=${name%.*}

mkdir -p build
cat > build/fig.tex <<TEX
\documentclass[tikz, border=2pt]{standalone}
\input{$preamble}
\begin{document}
$figure
\end{document}
TEX

# latexmk -cd compiles from inside build/, where a relative \input or \includegraphics in
# the preamble would be looked for. TEXINPUTS adds this folder to TeX's search path, after
# build/ itself -- ahead of it, a fig.tex lying beside this script would be compiled in
# place of the one just written -- and the trailing colon keeps TeX's own path last.
if TEXINPUTS=".:$PWD:${TEXINPUTS:-}" latexmk -pdf -cd -interaction=nonstopmode build/fig.tex > build/fig.log 2>&1; then
  echo "ok $name" > build/.build-status
else
  echo "fail see build/fig.log" > build/.build-status
  exit 1
fi
