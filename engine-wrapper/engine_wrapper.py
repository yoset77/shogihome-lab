import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path

from dotenv import load_dotenv

from common import BASE_DIR, is_bundled

# Configure logging
log_handlers = []

# Check if standard streams are available (Launcher connects pipes, so they should be)
if sys.stderr is not None:
    # Primary: Log to standard stream (captured by Launcher or Console)
    log_handlers.append(logging.StreamHandler())
elif is_bundled():
    # Fallback: Only log to file if running as bundled AND no console is attached
    log_file = BASE_DIR / "engine_wrapper.log"
    log_handlers.append(RotatingFileHandler(log_file, maxBytes=1 * 1024 * 1024, backupCount=2, encoding="utf-8"))
else:
    # Fallback for dev mode if stderr is missing (rare)
    log_handlers.append(logging.StreamHandler())

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s.%(msecs)03dZ] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    handlers=log_handlers,
)
logging.Formatter.converter = lambda *args: datetime.now(timezone.utc).timetuple()

logging.debug(f"is_bundled: {is_bundled()}")
logging.debug(f"sys.executable: {sys.executable}")
logging.debug(f"sys.argv[0]: {sys.argv[0]}")
logging.debug(f"Resolved BASE_DIR: {BASE_DIR}")

load_dotenv(dotenv_path=BASE_DIR / ".env")

HOST = os.getenv("BIND_ADDRESS", "127.0.0.1")
PORT = int(os.getenv("LISTEN_PORT", "4082"))


def get_engine_list():
    engines_json_path = BASE_DIR / "engines.json"
    engines = []

    if engines_json_path.exists():
        try:
            with open(engines_json_path, "r", encoding="utf-8") as f:
                engines = json.load(f)
        except Exception as e:
            logging.error(f"Failed to parse engines.json: {e}")
    else:
        logging.error(f"engines.json not found at {engines_json_path}. No engines available.")

    return engines


async def pipe_stream(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, log_prefix: str):
    try:
        while True:
            line_bytes = await reader.readline()
            if not line_bytes:
                break

            # Heuristic decoding: Try UTF-8 first, then CP932 (Shift-JIS) for Japanese engines
            try:
                line_str = line_bytes.decode("utf-8")
            except UnicodeDecodeError:
                try:
                    line_str = line_bytes.decode("cp932")
                except UnicodeDecodeError:
                    line_str = line_bytes.decode("utf-8", errors="replace")

            # Logging the decoded string
            text = line_str.strip()
            # Reduce logging noise: Skip 'info' commands unless debugging
            if text.startswith("info"):
                logging.debug(f"{log_prefix} {text}")
            else:
                logging.info(f"{log_prefix} {text}")

            # Always send as UTF-8 to the client (ShogiHome server)
            # This ensures that the Node.js side always receives valid UTF-8 strings.
            writer.write(line_str.encode("utf-8"))
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError, ConnectionAbortedError):
        pass
    except Exception as e:
        logging.error(f"Unexpected error in {log_prefix}: {e}", exc_info=True)
    finally:
        pass


async def apply_engine_options(stdin: asyncio.StreamWriter, options: dict):
    """Apply engine options from engines.json configuration."""
    if not options or not isinstance(options, dict):
        return

    for name, value in options.items():
        # Normalize boolean values to lowercase 'true'/'false' for USI compatibility
        if isinstance(value, bool):
            value = str(value).lower()

        # Sanitize: reject names/values containing line terminators
        name_str = str(name)
        value_str = str(value)
        if "\n" in name_str or "\r" in name_str or "\n" in value_str or "\r" in value_str:
            logging.warning(f"Skipping option with invalid characters: {name_str}")
            continue

        command = f"setoption name {name_str} value {value_str}\n"
        logging.info(f"Applying option: {command.strip()}")

        try:
            stdin.write(command.encode())
            await stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as e:
            logging.error(f"Failed to write option '{name}': {e}")
            raise
        except Exception as e:
            logging.error(f"Unexpected error writing option '{name}': {e}", exc_info=True)
            raise


async def handle_client(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter):
    peername = client_writer.get_extra_info("peername")
    logging.info(f"Client connected from {peername}")
    engine_process = None
    tasks_to_cancel = []

    access_token = os.getenv("WRAPPER_ACCESS_TOKEN")

    try:
        try:
            if access_token:
                nonce = secrets.token_hex(16)
                client_writer.write(f"auth_cram_sha256 {nonce}\n".encode())
                await client_writer.drain()

                # Wait for auth command
                auth_line = await client_reader.readline()
                if not auth_line:
                    logging.warning("Client disconnected during auth.")
                    return

                auth_cmd = auth_line.decode().strip()
                if auth_cmd.startswith("auth "):
                    digest = auth_cmd[5:].strip()
                    expected_digest = hmac.new(access_token.encode(), nonce.encode(), hashlib.sha256).hexdigest()

                    # Use timing-safe comparison to prevent timing attacks
                    if hmac.compare_digest(digest, expected_digest):
                        logging.info(f"Client authenticated successfully from {peername}")
                        client_writer.write(b"auth_ok\n")
                        await client_writer.drain()
                    else:
                        logging.warning(f"Authentication failed from {peername}")
                        client_writer.write(b"WRAPPER_ERROR: Authentication failed\n")
                        await client_writer.drain()
                        client_writer.close()
                        await client_writer.wait_closed()
                        return
                else:
                    logging.warning(f"Unexpected command during auth from {peername}: {auth_cmd}")
                    client_writer.write(b"WRAPPER_ERROR: Authentication required\n")
                    await client_writer.drain()
                    client_writer.close()
                    await client_writer.wait_closed()
                    return

            first_line = await client_reader.readline()
            if not first_line:
                logging.warning("Client disconnected before sending command.")
                return
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, OSError) as e:
            # Handle health check disconnects or immediate client exits gracefully
            logging.info(f"Client disconnected during handshake from {peername}: {e}")
            return

        command_line = first_line.decode().strip()
        logging.info(f"Received command: '{command_line}'")

        engines = get_engine_list()

        if command_line == "list":
            list_response = json.dumps(engines)
            client_writer.write(list_response.encode() + b"\n")
            await client_writer.drain()
            client_writer.close()
            await client_writer.wait_closed()
            return

        engine_id = ""
        if command_line.startswith("run "):
            engine_id = command_line[4:].strip()
        elif command_line == "research" or command_line == "game":
            # Backward compatibility
            engine_id = command_line
        else:
            logging.error(f"Invalid command received: {command_line}")
            client_writer.write(b"WRAPPER_ERROR: Invalid command. Use 'list' or 'run <id>'.\n")
            await client_writer.drain()
            return

        engine_def = next((e for e in engines if e["id"] == engine_id), None)
        if not engine_def:
            logging.error(f"Engine ID '{engine_id}' not found.")
            client_writer.write(f"WRAPPER_ERROR: Engine ID '{engine_id}' not found.\n".encode())
            await client_writer.drain()
            return

        engine_path_str = engine_def.get("path")
        if not engine_path_str:
            logging.error(f"Engine path for ID '{engine_id}' is not set.")
            client_writer.write(b"WRAPPER_ERROR: Engine path configuration error.\n")
            await client_writer.drain()
            return

        engine_path = Path(engine_path_str)
        # Resolve relative paths relative to the script directory
        if not engine_path.is_absolute():
            engine_path = (BASE_DIR / engine_path).resolve()

        engine_directory = engine_path.parent

        # Prevent new console window on Windows
        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NO_WINDOW

        try:
            engine_process = await asyncio.create_subprocess_exec(
                str(engine_path),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=engine_directory,
                creationflags=creationflags,
            )
        except FileNotFoundError:
            logging.error(f"Engine executable not found at '{engine_path}'")
            error_message = "WRAPPER_ERROR: Engine executable not found."
            client_writer.write(error_message.encode() + b"\n")
            await client_writer.drain()
            return
        except Exception as e:
            logging.error(f"Failed to start engine process: {e}", exc_info=True)
            error_message = "WRAPPER_ERROR: Failed to start engine process."
            client_writer.write(error_message.encode() + b"\n")
            await client_writer.drain()
            return

        engine_name = engine_def.get("name", "Unknown")
        short_id = engine_id[:5]
        logging.info(f"Started engine: {engine_name} (ID: {short_id}...) Path: {engine_path} (PID: {engine_process.pid})")

        options_applied = False  # Track if options have been applied

        async def client_to_engine():
            nonlocal options_applied
            try:
                while True:
                    line_bytes = await client_reader.readline()
                    if not line_bytes:
                        break
                    command = line_bytes.decode().strip()

                    # Inject options immediately BEFORE 'isready' command (only once)
                    if command == "isready" and not options_applied:
                        options = engine_def.get("options")
                        if options:
                            logging.info(f"Detected 'isready', applying engine options for '{engine_id}'...")
                            await apply_engine_options(engine_process.stdin, options)
                            options_applied = True

                    logging.info(f"[Client -> Engine] {command}")
                    engine_process.stdin.write(line_bytes)
                    await engine_process.stdin.drain()
            except Exception as e:
                logging.debug(f"Client to engine pipe closed: {e}")

        client_to_engine_task = asyncio.create_task(client_to_engine())
        engine_stdout_to_client_task = asyncio.create_task(pipe_stream(engine_process.stdout, client_writer, "[Engine -> Client]"))
        engine_stderr_to_client_task = asyncio.create_task(pipe_stream(engine_process.stderr, client_writer, "[Engine ERROR]"))
        engine_wait_task = asyncio.create_task(engine_process.wait())

        tasks_to_cancel = [
            client_to_engine_task,
            engine_stdout_to_client_task,
            engine_stderr_to_client_task,
            engine_wait_task,
        ]

        done, pending = await asyncio.wait(tasks_to_cancel, return_when=asyncio.FIRST_COMPLETED)

        for task in pending:
            task.cancel()

    except Exception as e:
        logging.error(f"An error occurred in client handler: {e}", exc_info=True)
    finally:
        for task in tasks_to_cancel:
            if not task.done():
                task.cancel()

        if engine_process:
            if engine_process.returncode is not None:
                logging.info(f"Engine process (PID: {engine_process.pid}) already exited with code {engine_process.returncode}.")
            else:
                logging.info(f"Cleaning up engine process (PID: {engine_process.pid}).")
                try:
                    # Send 'quit' command
                    if engine_process.stdin and not engine_process.stdin.is_closing():
                        logging.info("Sending 'quit' command to engine.")
                        engine_process.stdin.write(b"quit\n")
                        await engine_process.stdin.drain()
                        engine_process.stdin.close()

                    # Wait for engine to exit
                    try:
                        await asyncio.wait_for(engine_process.wait(), timeout=5.0)
                        logging.info(f"Engine process (PID: {engine_process.pid}) exited gracefully.")
                    except asyncio.TimeoutError:
                        logging.warning("Engine did not exit after 'quit' command. Terminating.")
                        if engine_process.returncode is None:
                            engine_process.terminate()
                            try:
                                await asyncio.wait_for(engine_process.wait(), timeout=3.0)
                            except asyncio.TimeoutError:
                                logging.warning(f"Engine process (PID: {engine_process.pid}) did not terminate gracefully, killing.")
                                if engine_process.returncode is None:
                                    engine_process.kill()
                                    await engine_process.wait()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    logging.warning("Engine stdin pipe already closed, could not send 'quit'.")
                except ProcessLookupError:
                    pass
            engine_process = None

        if client_writer and not client_writer.is_closing():
            client_writer.close()
            try:
                await client_writer.wait_closed()
            except Exception:
                pass

        logging.info(f"Client disconnected from {peername}.")


async def main():
    server = await asyncio.start_server(handle_client, HOST, PORT)
    addrs = ", ".join(str(sock.getsockname()) for sock in server.sockets)
    logging.info(f"Single-port engine wrapper server listening on {addrs}")

    engines_json_path = BASE_DIR / "engines.json"
    if engines_json_path.exists():
        logging.info(f"engines.json found at {engines_json_path}")
        try:
            with open(engines_json_path, "r", encoding="utf-8") as f:
                engines = json.load(f)
            logging.info(f"Loaded {len(engines)} engines from engines.json:")
            for e in engines:
                logging.info(f"  - {e.get('id')}: {e.get('name')} ({e.get('path')})")
        except Exception as e:
            logging.error(f"Failed to parse engines.json: {e}")
    else:
        logging.error("engines.json not found. Please create one based on engines.json.example.")

    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Server is shutting down.")
