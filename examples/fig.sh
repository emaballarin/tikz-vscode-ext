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

mkdir -p build
cat > build/fig.tex <<TEX
\documentclass[tikz, border=2pt]{standalone}
\input{$preamble}
\begin{document}
\input{$1}
\end{document}
TEX

# latexmk -cd compiles from inside build/, where a relative \input or \includegraphics in
# the preamble would be looked for. TEXINPUTS puts this folder on TeX's search path first;
# the trailing colon keeps TeX's own path after it.
if TEXINPUTS="$PWD:${TEXINPUTS:-}" latexmk -pdf -cd -interaction=nonstopmode build/fig.tex > build/fig.log 2>&1; then
  echo "ok $(basename "$1" .tex)" > build/.build-status
else
  echo "fail see build/fig.log" > build/.build-status
  exit 1
fi
