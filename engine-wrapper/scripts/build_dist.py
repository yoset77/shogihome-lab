import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

# Configuration - Explicitly pinned for reproducibility
PYTHON_VERSION = "3.13.11"
PYTHON_ZIP_NAME = f"python-{PYTHON_VERSION}-embed-amd64.zip"

# Paths
ROOT_DIR = Path(__file__).resolve().parents[2]
ENGINE_WRAPPER_DIR = ROOT_DIR / "engine-wrapper"
PYTHON_DIST_DIR = ENGINE_WRAPPER_DIR / "python"
EMBED_ZIP = ROOT_DIR / PYTHON_ZIP_NAME
PYTHON_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/{PYTHON_ZIP_NAME}"


def download_python():
    if EMBED_ZIP.exists():
        print(f"{EMBED_ZIP} already exists. Skipping download.")
        return

    print(f"Downloading Python {PYTHON_VERSION} from {PYTHON_URL}...")
    try:
        urllib.request.urlretrieve(PYTHON_URL, EMBED_ZIP)
        print("Download complete.")
    except Exception as e:
        print(f"Failed to download Python {PYTHON_VERSION}: {e}")
        raise


def extract_python():
    print(f"Extracting {EMBED_ZIP} to {PYTHON_DIST_DIR}...")
    if PYTHON_DIST_DIR.exists():
        shutil.rmtree(PYTHON_DIST_DIR)
    PYTHON_DIST_DIR.mkdir(parents=True)

    with zipfile.ZipFile(EMBED_ZIP, "r") as zip_ref:
        zip_ref.extractall(PYTHON_DIST_DIR)


def install_dependencies():
    print("Installing dependencies...")
    site_packages = PYTHON_DIST_DIR / "site-packages"
    site_packages.mkdir(parents=True, exist_ok=True)

    requirements_txt = ENGINE_WRAPPER_DIR / "requirements.txt"
    subprocess.run(
        ["uv", "export", "--no-dev", "--format", "requirements-txt", "-o", str(requirements_txt)], cwd=ENGINE_WRAPPER_DIR, check=True
    )

    subprocess.run(["uv", "pip", "install", "-r", str(requirements_txt), "--target", str(site_packages), "--no-cache"], check=True)

    if (site_packages / "customtkinter").exists():
        print("Successfully verified: customtkinter is installed.")
    else:
        print("Warning: customtkinter directory not found!")
    requirements_txt.unlink()


def fix_pth_file():
    print("Fixing .pth file...")
    pth_files = list(PYTHON_DIST_DIR.glob("*._pth"))
    if not pth_files:
        print("Warning: ._pth file not found!")
        return

    pth_file = pth_files[0]
    zip_name = list(PYTHON_DIST_DIR.glob("python*.zip"))[0].name

    # We must include the root directory (.) for DLLs to be found easily
    # and site-packages for the installed libraries.
    # We also add the parent directory (..) to allow importing local modules,
    # because the python directory is now inside engine-wrapper.
    new_content = [zip_name, ".", "..", "Lib", "site-packages", "import site", ""]
    pth_file.write_text("\n".join(new_content))


def copy_library_dlls():
    print("Collecting and copying library DLLs to Python root...")
    site_packages = PYTHON_DIST_DIR / "site-packages"

    # Copy Python.Runtime.dll and its companion files
    runtime_dir = None
    for dll in site_packages.rglob("Python.Runtime.dll"):
        runtime_dir = dll.parent
        break

    if runtime_dir:
        print(f"Found Python.Runtime.dll in {runtime_dir}. Copying all files from this directory...")
        for f in runtime_dir.glob("*"):
            if f.is_file():
                shutil.copy2(f, PYTHON_DIST_DIR)
    else:
        print("Warning: Python.Runtime.dll not found in site-packages!")

    # Copy WebView2Loader.dll
    for dll in site_packages.rglob("WebView2Loader.dll"):
        if "x64" in str(dll) or not (PYTHON_DIST_DIR / "WebView2Loader.dll").exists():
            shutil.copy2(dll, PYTHON_DIST_DIR)

    # Ensure pythonnet can find the python DLLs by copying them next to Python.Runtime.dll
    print("Copying Python DLLs to pythonnet runtime directory...")
    for runtime_dll in site_packages.rglob("Python.Runtime.dll"):
        runtime_dir = runtime_dll.parent
        for py_dll in PYTHON_DIST_DIR.glob("python*.dll"):
            print(f"Copying {py_dll.name} to {runtime_dir}...")
            shutil.copy2(py_dll, runtime_dir)


def copy_tkinter():
    print(f"Copying Tkinter and Site files from host Python ({PYTHON_VERSION})...")
    host_dir = Path(sys.base_prefix)

    # 0. site.py
    src_site_py = host_dir / "Lib" / "site.py"
    if src_site_py.exists():
        dest_lib = PYTHON_DIST_DIR / "Lib"
        dest_lib.mkdir(exist_ok=True)
        shutil.copy2(src_site_py, dest_lib)

    # 1. tkinter module
    src_tkinter_lib = host_dir / "Lib" / "tkinter"
    if src_tkinter_lib.exists():
        dest_tkinter_lib = PYTHON_DIST_DIR / "Lib" / "tkinter"
        if dest_tkinter_lib.exists():
            shutil.rmtree(dest_tkinter_lib)
        shutil.copytree(src_tkinter_lib, dest_tkinter_lib)

    # 2. DLLs and .pyd extensions
    search_dirs = [host_dir, host_dir / "DLLs"]
    for sd in search_dirs:
        if not sd.exists():
            continue
        for ext in ["*.dll", "*.pyd"]:
            for f in sd.glob(ext):
                if any(x in f.name.lower() for x in ["tcl", "tk", "sqlite", "zlib", "libcrypto", "libssl"]):
                    shutil.copy2(f, PYTHON_DIST_DIR)

    # 3. Tcl/Tk scripts
    src_tcl = host_dir / "tcl"
    if src_tcl.exists():
        dest_tcl = PYTHON_DIST_DIR / "tcl"
        if dest_tcl.exists():
            shutil.rmtree(dest_tcl)
        shutil.copytree(src_tcl, dest_tcl)


def create_dotnet_config():
    print("Creating .config files for .NET runtime...")
    config_content = """<?xml version="1.0" encoding="utf-8" ?>
<configuration>
  <runtime>
    <loadFromRemoteSources enabled="true"/>
  </runtime>
</configuration>
"""
    for exe_name in ["python.exe", "pythonw.exe"]:
        config_path = PYTHON_DIST_DIR / f"{exe_name}.config"
        print(f"Creating {config_path}...")
        config_path.write_text(config_content, encoding="utf-8")


if __name__ == "__main__":
    try:
        download_python()
        extract_python()
        install_dependencies()
        fix_pth_file()
        copy_library_dlls()
        copy_tkinter()
        create_dotnet_config()
        print(f"\nEmbedded Python {PYTHON_VERSION} distribution built successfully!")
    except Exception as e:
        print(f"\nError building distribution: {e}")
        sys.exit(1)
