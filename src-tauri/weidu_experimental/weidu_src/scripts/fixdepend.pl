#!/usr/bin/env perl
# Dependency-line path normalizer used by Makefile.ocaml.
#
# Reads ocamldep output on stdin, rewrites paths so that:
#  1. Any leading directory components (delimited by / or \) are stripped
#     from the dependencies (keeping only the basename).
#  2. Each remaining path is prefixed with $OBJDIR/ so make can find the
#     compiled artifact in the per-platform obj/<arch>/ directory.
#
# $OBJDIR is passed as the first command-line argument.
#
# This used to be a one-liner in Makefile.ocaml:
#   FIXDEPEND:=perl -e 'while(<>) { s%[^/\\ :]+[/\\]% %g; ... }'
# but Windows mingw32-make double-escapes backslashes in a way Linux bash
# does not, breaking the character class inside the regex. Moving the
# script into a file sidesteps the make→shell→perl escape chain entirely.

use strict;
use warnings;

my $objdir = shift @ARGV;
die "fixdepend.pl: missing OBJDIR argument\n" unless defined $objdir;

while (my $line = <STDIN>) {
    # Strip leading "<path>/" or "<path>\" components from each token.
    # Character class [^/\\ :] matches any char except /, \, space, or :.
    $line =~ s%[^/\\ :]+[/\\]% %g;
    # Prefix each remaining token with $objdir/ — leave separators alone.
    $line =~ s%([^ :\\\n\r]+)%$objdir/$1%g;
    print $line;
}
