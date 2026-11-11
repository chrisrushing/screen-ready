#!/bin/sh
# PDF/UA-1 check with veraPDF, using the local Java in tools/vendor. Usage: tools/pdfua.sh file.pdf [profile]
HERE="$(cd "$(dirname "$0")" && pwd)"
export JAVA_HOME="$HERE/vendor/jre/jdk-21.0.13+9-jre/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
exec "$HERE/vendor/verapdf/verapdf" -f "${2:-ua1}" --format mrr "$1"
