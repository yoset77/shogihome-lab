#!/usr/bin/env python3
import sys
for line in sys.stdin:
    c = line.strip()
    if c == 'usi':
        sys.stdout.write('option name Threads type spin default 1 min 1 max 128\n')
        sys.stdout.write('option name USI_Ponder type check default true\n')
        sys.stdout.write('usiok\n')
        sys.stdout.flush()
    elif c == 'quit':
        break
