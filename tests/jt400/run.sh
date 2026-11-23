#!/bin/bash
# Prueba los servidores host con el IBM Toolbox for Java real (jt400 de Maven Central):
# inicio de sesión, CommandCall, ProgramCall (BANCO/BNKSALDO), DataQueue y JDBC.
# Uso: tests/jt400/run.sh [puerto_base]   (8470 en Docker; en local, HOSTSVR_BASE)
set -e
cd "$(dirname "$0")"
VER=21.0.7
[ -f jt400.jar ] || curl -sSfL -o jt400.jar "https://repo1.maven.org/maven2/net/sf/jt400/jt400/$VER/jt400-$VER.jar"
SEP=":"; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";";; esac
javac -J-Xmx256m -cp jt400.jar -d out HostTest.java Jdbc.java
java -Xmx256m -Dbase="${1:-8470}" -Djdbc=1 -cp "out${SEP}jt400.jar" HostTest
