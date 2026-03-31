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


def parse_usi_option_line(line):
    """
    Parse a single USI 'option' line.
    format: option name <Name> type <Type> [default <Default>] [min <Min>] [max <Max>] [var <Var>]...
    """
    try:
        # Use shlex.split only as a base; it handles quotes if present.
        # But we need to handle raw spaces for unquoted names/values.
        parts = shlex.split(line)
        if not parts or parts[0] != "option":
            return None, None

        option_data = {}
        combo_vars = []

        # Keywords that mark the start of a new field
        keywords = {"name", "type", "default", "min", "max", "var"}

        i = 1
        n = len(parts)
        current_field = None

        name_parts = []
        type_val = None
        default_parts = []

        while i < n:
            part = parts[i]
            if part in keywords:
                current_field = part
                i += 1
                continue

            if current_field == "name":
                name_parts.append(part)
            elif current_field == "type":
                type_val = part
            elif current_field == "default":
                default_parts.append(part)
            elif current_field == "min":
                option_data["min"] = int(part)
            elif current_field == "max":
                option_data["max"] = int(part)
            elif current_field == "var":
                # var can appear multiple times, each one starts a new combo value
                # Collect until next keyword
                var_parts = [part]
                i += 1
                while i < n and parts[i] not in keywords:
                    var_parts.append(parts[i])
                    i += 1
                combo_vars.append(" ".join(var_parts))
                continue  # Skip the i += 1 at the end

            i += 1

        name = " ".join(name_parts)
        option_data["type"] = type_val

        if not name or not type_val:
            return None, None

        # Handle default value string joining
        default_val = " ".join(default_parts)
        if default_val == "<empty>":
            default_val = ""
        option_data["default"] = default_val

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

    except (ValueError, IndexError):
        return None, None


class Api:
    """
    Expose these methods to the JavaScript side via window.pywebview.api
    """

    def load(self):
        try:
            if ENGINES_JSON_PATH.exists():
                with open(ENGINES_JSON_PATH, "r", encoding="utf-8", errors="replace") as f:
                    engines_data = json.load(f)
            else:
                engines_data = []

            return {"engines": engines_data, "os": os.name}
        except Exception as e:
            return {"error": str(e)}

    def save(self, data):
        try:
            # Basic structure validation
            if not isinstance(data, list):
                raise ValueError("Root must be a list")

            # Validate each entry
            for i, entry in enumerate(data):
                if not isinstance(entry, dict):
                    raise ValueError(f"Entry at index {i} must be an object")

                # Required fields
                for field in ["id", "name", "path"]:
                    if field not in entry:
                        raise ValueError(f"Missing required field '{field}' in entry {i}")
                    if not isinstance(entry[field], str):
                        raise ValueError(f"Field '{field}' in entry {i} must be a string")

                if not entry["id"].strip():
                    raise ValueError(f"Engine ID in entry {i} cannot be empty")
                if not entry["path"].strip():
                    raise ValueError(f"Field 'path' in entry {i} cannot be empty")

                # Optional fields validation
                if "type" in entry:
                    if not isinstance(entry["type"], str):
                        raise ValueError(f"Field 'type' in entry {i} must be a string")
                    if entry["type"] not in ["game", "research", "both"]:
                        raise ValueError(f"Invalid type '{entry['type']}' in entry {i}")

                if "options" in entry and not isinstance(entry["options"], dict):
                    raise ValueError(f"Field 'options' in entry {i} must be an object")

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
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w")

    api = Api()
    # Create window
    webview.create_window(
        "ShogiHome LAN Config Editor",
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
