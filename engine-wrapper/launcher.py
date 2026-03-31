import io
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox

import customtkinter as ctk
import pystray
import qrcode
from PIL import Image
from pystray import MenuItem

from common import (
    BASE_DIR,
    get_local_ip,
    get_pc_url_config,
    get_python_exe,
    is_bundled,
    is_port_open,
    kill_proc_tree,
    load_env_value,
    smart_merge_env,
)

# --- Configuration ---
APP_NAME = "ShogiHome Lab"

# Determine execution mode (Source or Bundled)
IS_BUNDLED = is_bundled()
PYTHON_EXE = get_python_exe()

# Paths to directories
DIST_ROOT = BASE_DIR.parent
SHOGIHOME_DIR = DIST_ROOT / "shogihome"
WRAPPER_DIR = BASE_DIR

if IS_BUNDLED:
    ICON_PATH = DIST_ROOT / "icon.png"
    SERVER_ENV_PATH = SHOGIHOME_DIR / ".env"
    WRAPPER_ENV_PATH = WRAPPER_DIR / ".env"

    SERVER_EXE = SHOGIHOME_DIR / "shogihome-server.exe"
    # In bundled environment, we run .py scripts using python.exe
    WRAPPER_PY = WRAPPER_DIR / "engine_wrapper.py"
    CONFIG_PY = WRAPPER_DIR / "config_editor.py"
else:
    ICON_PATH = SHOGIHOME_DIR / "public" / "favicon.png"
    SERVER_ENV_PATH = SHOGIHOME_DIR / ".env"
    WRAPPER_ENV_PATH = WRAPPER_DIR / ".env"

    SERVER_DIR = SHOGIHOME_DIR
    WRAPPER_PY = WRAPPER_DIR / "engine_wrapper.py"
    CONFIG_PY = WRAPPER_DIR / "config_editor.py"

ctk.set_appearance_mode("System")
ctk.set_default_color_theme("blue")


class LauncherApp(ctk.CTk):
    def __init__(self):
        super().__init__()

        # Data Migration Check
        self._check_and_run_migration()

        # State variables
        self.server_process = None
        self.wrapper_process = None
        self.config_editor_process = None
        self.is_running = False
        self.tray_icon = None

        # Load initial config
        self.load_config()

        self.title(APP_NAME)
        self.geometry("400x540")
        self.resizable(False, False)

        # Handle window close (minimize to tray)
        self.protocol("WM_DELETE_WINDOW", self.minimize_to_tray)

        # Header
        self.header_frame = ctk.CTkFrame(self)
        self.header_frame.pack(fill="x", padx=10, pady=10)

        self.title_label = ctk.CTkLabel(self.header_frame, text=APP_NAME, font=("Roboto", 20, "bold"))
        self.title_label.pack(side="left", padx=10)

        self.status_indicator = ctk.CTkLabel(self.header_frame, text="● Stopped", text_color="#757575", font=("Roboto", 14))
        self.status_indicator.pack(side="right", padx=10)

        # Footer (Stop button) - Pack first to reserve bottom space
        self.btn_stop = ctk.CTkButton(
            self,
            text="Stop & Exit",
            command=self.quit_app,
            height=40,
            font=("Roboto", 14),
            fg_color="#d32f2f",
            hover_color="#b71c1c",
        )
        self.btn_stop.pack(side="bottom", fill="x", padx=20, pady=20)

        # QR Code and Info Section
        self.qr_frame = ctk.CTkFrame(self, fg_color="transparent")
        self.qr_frame.pack(pady=10)
        self.qr_label = None
        self.lan_link = None
        self.info_card = None

        self.setup_info_panel()

        # Main Actions
        self.action_frame = ctk.CTkFrame(self)
        self.action_frame.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        self.action_frame.columnconfigure((0, 1), weight=1)
        self.action_frame.rowconfigure((0, 1), weight=1)

        self.btn_open = ctk.CTkButton(
            self.action_frame,
            text="Open on PC",
            command=self.open_browser,
            height=60,
            font=("Roboto", 14),
            fg_color="#1161C9",
            hover_color="#124BC5",
            state="normal" if self.is_pc_access_allowed else "disabled",
        )
        self.btn_open.grid(row=0, column=0, padx=10, pady=10, sticky="nsew")

        self.btn_settings = ctk.CTkButton(
            self.action_frame,
            text="Engine Settings",
            command=self.open_settings,
            height=60,
            font=("Roboto", 14),
            fg_color="#2083e6",
            hover_color="#1868b8",
        )
        self.btn_settings.grid(row=0, column=1, padx=10, pady=10, sticky="nsew")

        self.btn_restart = ctk.CTkButton(
            self.action_frame,
            text="Restart Server",
            command=self.restart_services,
            height=60,
            font=("Roboto", 14),
            fg_color="#f76b0e",
            hover_color="#f55a12",
        )
        self.btn_restart.grid(row=1, column=0, padx=10, pady=10, sticky="nsew")

        self.btn_logs = ctk.CTkButton(
            self.action_frame,
            text="Show Logs",
            command=self.open_log_viewer,
            height=60,
            font=("Roboto", 14),
            fg_color="#607d8b",
            hover_color="#455a64",
        )
        self.btn_logs.grid(row=1, column=1, padx=10, pady=10, sticky="nsew")

        # Start processes on load
        self.after(100, self.start_services)
        self.after(1000, self.check_processes)

    def load_config(self):
        """Load or reload configuration from .env files."""
        self.server_port = load_env_value(SERVER_ENV_PATH, "PORT", 8140)
        self.wrapper_port = load_env_value(WRAPPER_ENV_PATH, "LISTEN_PORT", 4082)

        # LAN access configuration
        self.bind_address = load_env_value(SERVER_ENV_PATH, "BIND_ADDRESS", "0.0.0.0")
        self.disable_auto_allowed_origins = str(load_env_value(SERVER_ENV_PATH, "DISABLE_AUTO_ALLOWED_ORIGINS", "false")).lower() == "true"
        allowed_origins_raw = load_env_value(SERVER_ENV_PATH, "ALLOWED_ORIGINS", "")
        self.allowed_origins = [o.strip() for o in allowed_origins_raw.split(",") if o.strip()]

        # Determine best URL for PC access and if it's allowed
        self.pc_url, self.is_pc_access_allowed = get_pc_url_config(
            self.bind_address,
            self.server_port,
            self.disable_auto_allowed_origins,
            self.allowed_origins,
            get_local_ip(),
        )

    def setup_info_panel(self):
        """Setup or refresh the QR code / Info panel."""
        # Clear existing widgets if any
        if self.qr_label:
            self.qr_label.destroy()
            self.qr_label = None
        if self.lan_link:
            self.lan_link.destroy()
            self.lan_link = None
        if self.info_card:
            self.info_card.destroy()
            self.info_card = None

        # Show QR code only if LAN access is enabled and secure (default mode)
        show_qr = (self.bind_address == "0.0.0.0") and (not self.disable_auto_allowed_origins)

        if show_qr:
            local_ip = get_local_ip()
            lan_url = f"http://{local_ip}:{self.server_port}"

            qr = qrcode.QRCode(box_size=4, border=2)
            qr.add_data(lan_url)
            qr.make(fit=True)
            qr_img_wrapper = qr.make_image(fill_color="black", back_color="white")

            # Convert to standard PIL Image
            buf = io.BytesIO()
            qr_img_wrapper.save(buf, format="PNG")
            buf.seek(0)
            qr_img = Image.open(buf)

            # Convert to CTkImage
            self.qr_image = ctk.CTkImage(light_image=qr_img, dark_image=qr_img, size=(180, 180))
            self.qr_label = ctk.CTkLabel(self.qr_frame, image=self.qr_image, text="")
            self.qr_label.pack()

            self.lan_link = ctk.CTkLabel(
                self.qr_frame,
                text=lan_url,
                font=("Roboto", 14),
                text_color=("#0d6efd", "#4dabf7"),
                cursor="hand2",
            )
            self.lan_link.pack(pady=5)
            self.lan_link.bind("<Button-1>", lambda e: webbrowser.open(lan_url))
        else:
            # Display a styled info card instead of a bare placeholder
            self.info_card = ctk.CTkFrame(self.qr_frame, corner_radius=10, border_width=1, border_color=("#dbdbdb", "#2b2b2b"))
            self.info_card.pack(padx=20, pady=10)

            ctk.CTkLabel(
                self.info_card,
                text="Custom Network Active",
                font=("Roboto", 14, "bold"),
            ).pack(pady=(15, 5), padx=20)

            ctk.CTkLabel(
                self.info_card,
                text=(
                    f"Binding: {self.bind_address}\n"
                    f"Auto-Origins: {'Disabled' if self.disable_auto_allowed_origins else 'Enabled'}\n\n"
                    "Please use your manually\n"
                    "configured URL or proxy\n"
                    "to access from other devices."
                ),
                font=("Roboto", 12),
                text_color=("#3b3b3b", "#bbbbbb"),
                justify="center",
            ).pack(pady=(0, 15), padx=20)

    def minimize_to_tray(self):
        self.withdraw()

    def show_window(self):
        self.after(0, self._handle_show_window)

    def _handle_show_window(self):
        try:
            self.deiconify()
            self.lift()
            self.focus_force()
        except Exception:
            pass

    def update_status(self, running):
        self.is_running = running

        def _update():
            if running:
                self.status_indicator.configure(text="● Running", text_color="#4caf50")  # Green
                if self.is_pc_access_allowed:
                    self.btn_open.configure(state="normal")
                self.btn_restart.configure(state="normal")
                self.btn_settings.configure(state="normal")
            else:
                self.status_indicator.configure(text="● Stopped", text_color="#757575")  # Gray
                self.btn_open.configure(state="disabled")
                self.btn_restart.configure(state="normal")
                self.btn_settings.configure(state="normal")

        self.after(0, _update)

    def check_processes(self):
        if self.is_running:
            # Check if any process died
            server_dead = self.server_process and self.server_process.poll() is not None
            wrapper_dead = self.wrapper_process and self.wrapper_process.poll() is not None

            if server_dead or wrapper_dead:
                self.update_status(False)
                self.after(0, lambda: self.status_indicator.configure(text="● Error", text_color="#f44336"))

        # Monitor config editor process
        if self.config_editor_process and self.config_editor_process.poll() is not None:
            self.config_editor_process = None
            self.after(0, lambda: self.btn_settings.configure(text="Engine Settings"))

        # Schedule next check
        self.after(2000, self.check_processes)

    def start_services(self):
        if self.is_running:
            return

        self.status_indicator.configure(text="⟳ Starting...", text_color="#ff9800")  # Orange
        self.btn_restart.configure(state="disabled")

        threading.Thread(target=self._run_processes, daemon=True).start()

    def _run_processes(self):
        # Prepare logs
        log_dir = BASE_DIR / "logs"
        log_dir.mkdir(exist_ok=True)

        # Rotate logs
        for log_name in ["server.log", "wrapper.log"]:
            log_path = log_dir / log_name
            if log_path.exists():
                old_path = log_path.with_suffix(".log.old")
                try:
                    if old_path.exists():
                        old_path.unlink()
                    log_path.rename(old_path)
                except Exception:
                    pass

        try:
            with (
                open(log_dir / "server.log", "w", encoding="utf-8") as server_log,
                open(log_dir / "wrapper.log", "w", encoding="utf-8") as wrapper_log,
            ):
                server_log.write(f"--- {time.ctime()} Starting Server ---\n")
                wrapper_log.write(f"--- {time.ctime()} Starting Wrapper ---\n")

                startup_info = None
                if os.name == "nt":
                    startup_info = subprocess.STARTUPINFO()
                    startup_info.dwFlags |= subprocess.STARTF_USESHOWWINDOW

                # Start Wrapper
                try:
                    if IS_BUNDLED:
                        wrapper_cmd = [str(PYTHON_EXE), str(WRAPPER_PY)]
                        # Ensure CWD is where engines.json/.env reside (engine-wrapper root)
                        cwd = WRAPPER_DIR
                    else:
                        wrapper_cmd = ["uv", "run", "engine_wrapper.py"]
                        cwd = WRAPPER_DIR

                    wrapper_log.write(f"Executing Wrapper: {wrapper_cmd}\nCWD: {cwd}\n")
                    wrapper_log.flush()

                    self.wrapper_process = subprocess.Popen(
                        wrapper_cmd,
                        cwd=str(cwd),
                        stdout=wrapper_log,
                        stderr=wrapper_log,
                        startupinfo=startup_info,
                    )
                except Exception as e:
                    wrapper_log.write(f"Failed to start wrapper: {e}\n")
                    wrapper_log.flush()

                # Start Server
                try:
                    if IS_BUNDLED:
                        server_cmd = [str(SERVER_EXE)]
                        cwd = SERVER_EXE.parent
                    else:
                        server_cmd = ["npm", "run", "server:start"]
                        cwd = SERVER_DIR

                    use_shell = not IS_BUNDLED

                    server_log.write(f"Executing Server: {server_cmd}\nCWD: {cwd}\n")
                    server_log.flush()

                    self.server_process = subprocess.Popen(
                        server_cmd,
                        cwd=str(cwd),
                        stdout=server_log,
                        stderr=server_log,
                        shell=use_shell,
                        startupinfo=startup_info,
                    )
                except Exception as e:
                    server_log.write(f"Failed to start server: {e}\n")
                    server_log.flush()

                # Wait for both ports to open (up to 10 seconds)
                start_wait = time.time()
                success = False
                while time.time() - start_wait < 10:
                    # Check if ports are open
                    # Server might be bound to a specific IP. If 0.0.0.0, we check 127.0.0.1.
                    server_host = self.bind_address if self.bind_address != "0.0.0.0" else "127.0.0.1"
                    ports_ok = is_port_open(self.server_port, host=server_host) and is_port_open(self.wrapper_port, host="127.0.0.1")

                    # Check if our processes are still alive
                    server_alive = self.server_process and self.server_process.poll() is None
                    wrapper_alive = self.wrapper_process and self.wrapper_process.poll() is None

                    if ports_ok and server_alive and wrapper_alive:
                        success = True
                        break

                    # Early exit if any process has already crashed
                    if not server_alive or not wrapper_alive:
                        break

                    time.sleep(0.5)

                # Flush final logs before exiting the with block (closing handles)
                server_log.flush()
                wrapper_log.flush()

        except Exception:
            self.after(0, lambda: self.status_indicator.configure(text="● Log Error", text_color="#f44336"))
            return

        if success:
            self.update_status(True)
        else:
            self.after(0, lambda: self.status_indicator.configure(text="● Error", text_color="#f44336"))
            self.update_status(False)

    def stop_services(self):
        self.after(0, lambda: self.status_indicator.configure(text="Stopping...", text_color="#f44336"))

        if self.server_process:
            self._kill_proc_tree(self.server_process)
            self.server_process = None
        if self.wrapper_process:
            self._kill_proc_tree(self.wrapper_process)
            self.wrapper_process = None
        if self.config_editor_process:
            self._kill_proc_tree(self.config_editor_process)
            self.config_editor_process = None
            try:
                self.after(0, lambda: self.btn_settings.configure(text="Engine Settings"))
            except Exception:
                pass

        self.update_status(False)

    def restart_services(self):
        # Run in thread to avoid freezing UI
        def _restart():
            self.after(0, lambda: self.btn_restart.configure(state="disabled", text="Restarting..."))
            self.stop_services()
            # Slight delay to ensure ports are freed
            time.sleep(1.0)
            # Reload config before starting again
            self.load_config()
            # Refresh UI components (QR code, Open button state)
            self.after(0, self.setup_info_panel)
            self.after(0, lambda: self.btn_open.configure(state="normal" if self.is_pc_access_allowed else "disabled"))
            # Start
            self.after(0, self.start_services)
            self.after(0, lambda: self.btn_restart.configure(text="Restart Server"))

        threading.Thread(target=_restart, daemon=True).start()

    def open_log_viewer(self):
        log_window = ctk.CTkToplevel(self)
        log_window.title("Log Viewer")
        log_window.geometry("600x400")
        log_window.attributes("-topmost", True)

        tabview = ctk.CTkTabview(log_window)
        tabview.pack(fill="both", expand=True, padx=10, pady=10)

        tab_server = tabview.add("Server Log")
        tab_wrapper = tabview.add("Wrapper Log")

        text_server = ctk.CTkTextbox(tab_server)
        text_server.pack(fill="both", expand=True)

        text_wrapper = ctk.CTkTextbox(tab_wrapper)
        text_wrapper.pack(fill="both", expand=True)

        def refresh_logs():
            log_dir = BASE_DIR / "logs"

            def _read_last_mb(path, textbox):
                if not path.exists():
                    return
                try:
                    with open(path, "r", encoding="utf-8", errors="ignore") as f:
                        f.seek(0, 2)
                        size = f.tell()
                        limit = 1024 * 1024  # 1MB limit for viewer
                        if size > limit:
                            f.seek(size - limit)
                            content = "... (truncated) ...\n" + f.read()
                        else:
                            f.seek(0)
                            content = f.read()
                        textbox.delete("1.0", "end")
                        textbox.insert("1.0", content)
                        textbox.see("end")
                except Exception as e:
                    textbox.insert("end", f"\nError reading log: {e}")

            _read_last_mb(log_dir / "server.log", text_server)
            _read_last_mb(log_dir / "wrapper.log", text_wrapper)

        btn_refresh = ctk.CTkButton(log_window, text="Refresh", command=refresh_logs)
        btn_refresh.pack(pady=10)

        refresh_logs()

    def open_browser(self, auto=False):
        # Open the allowed URL on PC
        webbrowser.open(self.pc_url)

    def open_settings(self):
        if self.config_editor_process and self.config_editor_process.poll() is None:
            # The config editor is a GUI window, so we don't need to open a browser.
            # Just bring it to front (if possible) or do nothing as it's already running.
            return

        startup_info = None
        if os.name == "nt":
            startup_info = subprocess.STARTUPINFO()
            startup_info.dwFlags |= subprocess.STARTF_USESHOWWINDOW

        if IS_BUNDLED:
            cmd = [str(PYTHON_EXE), str(CONFIG_PY)]
            # Ensure CWD is where engines.json/.env reside
            cwd = WRAPPER_DIR
        else:
            cwd = WRAPPER_DIR
            cmd = ["uv", "run", "config_editor.py"]

        try:
            self.config_editor_process = subprocess.Popen(
                cmd,
                cwd=str(cwd),
                # config_editor is a GUI app, so we don't need startupinfo to hide console
            )
            # Update button text to indicate it's already running
            self.btn_settings.configure(text="Settings Running")
        except Exception as e:
            print(f"Failed to start config editor: {e}")

    def quit_app(self):
        # Always use after(0) to ensure UI operations run on the main thread,
        # especially when called from the system tray thread.
        self.after(0, self._handle_quit)

    def _handle_quit(self):
        try:
            # UI Feedback
            self.btn_stop.configure(text="Stopping...", state="disabled")
            self.btn_restart.configure(state="disabled")
            self.btn_open.configure(state="disabled")
            self.btn_settings.configure(state="disabled")
            self.update()  # Force UI update
        except Exception:
            # Window might already be destroyed
            pass

        self.stop_services()

        if self.tray_icon:
            self.tray_icon.stop()

        # Wait 200ms before quitting the mainloop to allow tray icon cleanup to finish.
        # This prevents the icon from lingering in the Windows taskbar until hovered.
        self.after(200, self.quit)

    def _kill_proc_tree(self, proc):
        # Force kill using common utility
        kill_proc_tree(proc.pid)

    def _check_and_run_migration(self):

        data_dir = SHOGIHOME_DIR / "data"
        engines_json_dest = WRAPPER_DIR / "engines.json"

        # Check if this is a fresh extraction
        if not data_dir.exists():
            msg = "旧バージョンのデータを引き継ぎますか？\n(Do you want to migrate data from the old version?)"
            # Temporary hidden root for messagebox/filedialog
            import tkinter as tk

            root = tk.Tk()
            root.withdraw()

            response = messagebox.askyesno("Data Migration", msg, parent=root)
            if response:
                old_dir_str = filedialog.askdirectory(title="Select old ShogiHome Lab/LAN directory", parent=root)
                if old_dir_str:
                    old_dir = Path(old_dir_str)

                    # ZIP 展開時の 2 重フォルダ対策：shogihome がない場合、1 階層下を検索
                    if not (old_dir / "shogihome").exists():
                        for sub in old_dir.iterdir():
                            if sub.is_dir() and (sub / "shogihome").exists():
                                old_dir = sub
                                break

                    old_data_dir = old_dir / "shogihome" / "data"
                    old_engines_json = old_dir / "engine-wrapper" / "engines.json"
                    old_shogihome_env = old_dir / "shogihome" / ".env"
                    old_wrapper_env = old_dir / "engine-wrapper" / ".env"

                    # 存在チェックと詳細なバリデーション
                    missing = []
                    if not old_data_dir.exists():
                        missing.append("- shogihome/data (棋譜データ等)")
                    if not old_engines_json.exists():
                        missing.append("- engine-wrapper/engines.json (エンジン設定)")
                    if not old_shogihome_env.exists() and not old_wrapper_env.exists():
                        missing.append("- .env (ネットワーク設定等)")

                    if len(missing) == 3:
                        messagebox.showerror(
                            "Error",
                            "選択されたフォルダに引継ぎ可能なデータが見つかりませんでした。",
                            parent=root,
                        )
                        root.destroy()
                        return

                    if missing:
                        warn_msg = "以下のデータが見つかりません。続行しますか？\n\n" + "\n".join(missing)
                        if not messagebox.askyesno("Warning", warn_msg, parent=root):
                            root.destroy()
                            return

                    try:
                        # 1. Copy data directory
                        if old_data_dir.exists():
                            shutil.copytree(old_data_dir, data_dir)

                        # 2. Copy engines.json
                        if old_engines_json.exists():
                            shutil.copy2(old_engines_json, engines_json_dest)

                        # 3. Smart Merge .env files (Robust encodings)
                        if old_shogihome_env.exists():
                            smart_merge_env(old_shogihome_env, SERVER_ENV_PATH, SERVER_ENV_PATH)
                        if old_wrapper_env.exists():
                            smart_merge_env(old_wrapper_env, WRAPPER_ENV_PATH, WRAPPER_ENV_PATH)

                        messagebox.showinfo(
                            "Success",
                            "データの引き継ぎが完了しました。\n旧ージョンのフォルダは、不要であれば削除してください。",
                            parent=root,
                        )
                    except Exception as e:
                        messagebox.showerror("Error", f"Failed to migrate data:\n{e}", parent=root)

                root.destroy()


# --- Tray Icon ---
def setup_tray(app):
    if ICON_PATH.exists():
        image = Image.open(ICON_PATH)
    else:
        # Create dummy icon if missing
        image = Image.new("RGB", (64, 64), color=(73, 109, 137))

    menu = pystray.Menu(
        MenuItem("Open ShogiHome", lambda: app.open_browser()),
        MenuItem("Dashboard", lambda: app.show_window(), default=True),
        MenuItem("Settings", lambda: app.open_settings()),
        pystray.Menu.SEPARATOR,
        MenuItem("Exit", lambda: app.quit_app()),
    )

    app.tray_icon = pystray.Icon("ShogiHome Lab", image, "ShogiHome Lab", menu)
    app.tray_icon.run()


# --- Main ---
if __name__ == "__main__":
    app = LauncherApp()

    # Run tray in separate thread (pystray run is blocking)
    threading.Thread(target=setup_tray, args=(app,), daemon=True).start()

    app.mainloop()
    sys.exit(0)
