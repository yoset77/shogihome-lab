import json
import os
import queue
import shlex
import subprocess
import sys
import threading
import time
from pathlib import Path

from common import BASE_DIR, is_bundled

# --- pythonnet / clr-loader initialization ---
# For bundled environment, explicitly set the Python DLL path for pythonnet
if is_bundled() and os.name == "nt":
    python_dll = BASE_DIR / "python" / "python313.dll"
    if python_dll.exists():
        os.environ["PYTHONNET_PYDLL"] = str(python_dll)

import webview

# --- Path Resolution Logic ---

# 1. Search for engines.json
ENGINES_JSON_PATH = BASE_DIR / "engines.json"

# 2. Search for config_editor.html
HTML_PATH = BASE_DIR / "config_editor.html"

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")


def parse_usi_option_line(line):
    """
    Parse a single USI 'option' line.
    format: option name <Name> type <Type> [default <Default>] [min <Min>] [max <Max>] [var <Var>]...
    """
    try:
        parts = shlex.split(line)
        if not parts or parts[0] != "option":
            return None, None

        it = iter(parts[1:])
        name = None
        option_data = {}
        combo_vars = []

        for part in it:
            if part == "name":
                name = next(it)
            elif part == "type":
                option_data["type"] = next(it)
            elif part == "default":
                default_val = next(it)
                if default_val == "<empty>":
                    default_val = ""
                option_data["default"] = default_val
            elif part == "min":
                option_data["min"] = int(next(it))
            elif part == "max":
                option_data["max"] = int(next(it))
            elif part == "var":
                combo_vars.append(next(it))

        if not name or "type" not in option_data:
            return None, None

        # Type specific handling
        opt_type = option_data["type"]
        if opt_type == "check":
            option_data["default"] = str(option_data.get("default", "false")).lower() == "true"
        elif opt_type == "spin":
            option_data["min"] = option_data.get("min", 0)
            option_data["max"] = option_data.get("max", 1000000)
            try:
                option_data["default"] = int(option_data.get("default", option_data["min"]))
            except (ValueError, TypeError):
                option_data["default"] = option_data["min"]
        elif opt_type == "combo":
            option_data["vars"] = combo_vars

        return name, option_data

    except (ValueError, StopIteration, IndexError):
        return None, None


class Api:
    """
    Expose these methods to the JavaScript side via window.pywebview.api
    """

    def load(self):
        try:
            if ENGINES_JSON_PATH.exists():
                with open(ENGINES_JSON_PATH, "r", encoding="utf-8") as f:
                    engines_data = json.load(f)
            else:
                engines_data = []

            return {"engines": engines_data, "os": os.name}
        except Exception as e:
            return {"error": str(e)}

    def save(self, data):
        try:
            # Basic validation
            if not isinstance(data, list):
                raise ValueError("Root must be a list")

            # Write to file
            with open(ENGINES_JSON_PATH, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)

            return {"status": "ok"}
        except Exception as e:
            return {"error": str(e)}

    def browse(self):
        try:
            # pywebview has its own file dialog
            file_types = ("Executable (*.exe)", "All files (*.*)")
            result = webview.active_window().create_file_dialog(webview.FileDialog.OPEN, allow_multiple=False, file_types=file_types)

            if result and len(result) > 0:
                file_path = str(Path(result[0]).resolve())
                return {"status": "ok", "path": file_path}
            else:
                return {"status": "cancel"}
        except Exception as e:
            return {"error": str(e)}

    def analyze(self, path_str):
        try:
            if not path_str:
                raise ValueError("Path is required")

            try:
                engine_path = Path(path_str).expanduser()
                if not engine_path.is_absolute():
                    engine_path = (BASE_DIR / engine_path).resolve()
                else:
                    engine_path = engine_path.resolve()
            except Exception as e:
                raise ValueError(f"Invalid path format: {e}") from e

            if not engine_path.exists():
                raise FileNotFoundError(f"Engine not found at: {engine_path}")
            if not engine_path.is_file():
                raise ValueError(f"Path is not a file: {engine_path}")

            options = self.get_usi_options(engine_path)
            return {"status": "ok", "options": options}

        except Exception as e:
            return {"error": str(e)}

    def get_usi_options(self, engine_path):
        # Start process
        cwd = engine_path.parent
        proc = None

        # Suppress console window on Windows
        startupinfo = None
        if os.name == "nt":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

        try:
            proc = subprocess.Popen(
                [str(engine_path)],
                cwd=str(cwd),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                encoding="utf-8",
                errors="replace",
                startupinfo=startupinfo,
            )
        except Exception as e:
            raise RuntimeError(f"Failed to start engine: {e}") from e

        options = {}

        try:
            q = queue.Queue()

            def reader_thread():
                try:
                    for line in proc.stdout:
                        q.put(line)
                    proc.stdout.close()
                except Exception:
                    pass

            t = threading.Thread(target=reader_thread, daemon=True)
            t.start()

            if proc.stdin:
                try:
                    proc.stdin.write("usi\n")
                    proc.stdin.flush()
                except OSError:
                    pass

            # Read with timeout
            start_time = time.time()
            timeout_sec = 5.0

            while True:
                remaining = timeout_sec - (time.time() - start_time)
                if remaining <= 0:
                    raise TimeoutError("Engine USI response timed out")

                try:
                    line = q.get(timeout=remaining)
                except queue.Empty as e:
                    raise TimeoutError("Engine USI response timed out") from e

                line = line.strip()
                if line == "usiok":
                    break

                if line.startswith("option"):
                    name, opt_def = parse_usi_option_line(line)
                    if name and opt_def:
                        options[name] = opt_def

            # Send quit
            if proc.stdin:
                try:
                    proc.stdin.write("quit\n")
                    proc.stdin.flush()
                except OSError:
                    pass

            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()

        except Exception as e:
            if proc:
                proc.kill()
            raise e
        finally:
            if proc and proc.poll() is None:
                proc.kill()

        return options


def run_app():
    api = Api()
    # Create window
    webview.create_window(
        "ShogiHome Engine Config Editor",
        str(HTML_PATH),
        js_api=api,
        width=800,
        height=900,
        min_size=(600, 600),
    )

    # Start the app
    # On Windows, Edge/WebView2 will be used if available
    webview.start()


if __name__ == "__main__":
    run_app()
