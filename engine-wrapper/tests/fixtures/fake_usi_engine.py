"""Minimal fake USI engine for black-box wrapper contract tests.

Protocol:
- `usi` -> `id name fake-engine`, `usiok`
- `isready` -> `readyok`
- `test_cp932` -> one CP932-encoded line (Japanese), then `test_cp932_ok`
- `quit` -> exit promptly
- anything else starting with `setoption` is recorded; other lines are ignored.

Every received stdin line is appended to the file named by FAKE_ENGINE_LOG
(when set), so tests can assert option injection ordering.
"""

import os
import sys


def _log(path, line):
    if not path:
        return
    with open(path, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def main():
    log_path = os.environ.get("FAKE_ENGINE_LOG", "")
    out = sys.stdout
    for raw in sys.stdin:
        line = raw.strip()
        _log(log_path, line)
        if line == "usi":
            out.write("id name fake-engine\n")
            out.write("usiok\n")
            out.flush()
        elif line == "isready":
            out.write("readyok\n")
            out.flush()
        elif line == "test_cp932":
            # Emit raw CP932 bytes, bypassing the text-mode stdout encoding.
            sys.stdout.buffer.write("info string こんにちは\n".encode("cp932"))
            sys.stdout.buffer.flush()
            out.write("test_cp932_ok\n")
            out.flush()
        elif line == "quit":
            break


if __name__ == "__main__":
    main()
