#!/usr/bin/env python3
"""
One Thing At A Time — native file writer.

Firefox starts this program when the extension sends a message (native messaging:
4-byte little-endian length + UTF-8 JSON on stdin, same framing for the reply on stdout).

An empty "folder" means the default: the one set at install time (otaat_host_config.json next to
this script), otherwise Documents/OneThingAtATime.

Messages:
  {"type": "hello",  "folder": ""}                                   -> {"ok", "version", "folder"}
  {"type": "append", "folder": "", "log": "<id of the browser's log>",
   "files": [{"path", "header", "lines": [[event id, text], ...]}]}
        Appends the lines to each file (inside the log folder), header first if the file is new.
        Lines already written (tracked per log and file in .otaat-state.json) are skipped, so retries
        never duplicate anything.
  {"type": "open",   "folder": "", "path": ""}                       Opens the folder (or a file in it).

It only ever appends (never truncates or deletes) and never writes outside the log folder.
"""
import json
import os
import struct
import subprocess
import sys

VERSION = "1.0.0"
APP_FOLDER = "OneThingAtATime"
MAX_MESSAGE = 64 * 1024 * 1024


def documents_dir():
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            class GUID(ctypes.Structure):
                _fields_ = [
                    ("Data1", wintypes.DWORD),
                    ("Data2", wintypes.WORD),
                    ("Data3", wintypes.WORD),
                    ("Data4", wintypes.BYTE * 8),
                ]

            # FOLDERID_Documents {FDD39AD0-238F-46AF-ADB4-6C85480369C7}
            fid = GUID(0xFDD39AD0, 0x238F, 0x46AF, (wintypes.BYTE * 8)(0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7))
            path_ptr = ctypes.c_wchar_p()
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(path_ptr)) == 0:
                path = path_ptr.value
                ctypes.windll.ole32.CoTaskMemFree(path_ptr)
                if path:
                    return path
        except Exception:
            pass
    return os.path.join(os.path.expanduser("~"), "Documents")


# Written by the installer (-LogFolder): the folder used when the extension's setting is left empty.
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "otaat_host_config.json")


def resolve(folder):
    return os.path.abspath(os.path.expandvars(os.path.expanduser(folder)))


def default_root():
    try:
        with open(CONFIG_FILE, encoding="utf-8-sig") as fh:
            folder = str((json.load(fh) or {}).get("folder") or "").strip()
        if folder:
            return resolve(folder)
    except (OSError, ValueError, AttributeError):
        pass
    return os.path.join(documents_dir(), APP_FOLDER)


def log_root(folder):
    folder = (folder or "").strip()
    root = resolve(folder) if folder else default_root()
    os.makedirs(root, exist_ok=True)
    return root


def safe_path(root, rel):
    rel = str(rel or "").replace("\\", "/")
    if rel.startswith("/"):
        raise ValueError("absolute paths are not allowed: %r" % rel)
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." or ":" in p for p in parts):
        raise ValueError("unsafe path: %r" % rel)
    full = os.path.abspath(os.path.join(root, *parts))
    if os.path.commonpath([full, root]) != root:
        raise ValueError("path escapes the log folder: %r" % rel)
    return full


def encode(text):
    # "replace": anything that can't be UTF-8 (e.g. half an emoji) becomes "?" instead of failing the batch.
    return str(text or "").encode("utf-8", "replace")


STATE_FILE = ".otaat-state.json"


def load_state(root):
    try:
        with open(os.path.join(root, STATE_FILE), encoding="utf-8") as fh:
            state = json.load(fh)
        if isinstance(state, dict) and isinstance(state.get("written"), dict):
            return state
    except FileNotFoundError:
        pass
    except Exception:
        # Unreadable bookkeeping: keep a copy for inspection and start over (worst case: some lines twice).
        try:
            os.replace(os.path.join(root, STATE_FILE), os.path.join(root, STATE_FILE + ".bad"))
        except OSError:
            pass
    return {"version": 1, "written": {}}


def save_state(root, state):
    path = os.path.join(root, STATE_FILE)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def append_files(root, log_id, files):
    """
    Each file comes with numbered lines: [[event id, text], ...]. The host remembers, per log and file,
    the highest event id already written, and skips anything at or below it. So a retry after a partial
    failure (e.g. one file locked by another program) never writes a line twice.
    """
    # Check every path and encode every text before writing anything.
    plan = []
    for f in files:
        if os.path.basename(str(f.get("path"))).startswith(STATE_FILE):
            raise ValueError("reserved file name")
        lines = [(int(i), encode(t)) for i, t in (f.get("lines") or [])]
        plan.append((str(f.get("path")), safe_path(root, f.get("path")), encode(f.get("header")), lines))
    state = load_state(root)
    written = state["written"]
    count = 0
    for rel, full, header, lines in plan:
        key = "%s|%s" % (log_id, rel.replace("\\", "/"))
        last = int(written.get(key, 0))
        new = [(i, t) for i, t in lines if i > last]
        if not new:
            continue
        os.makedirs(os.path.dirname(full), exist_ok=True)
        is_new = not os.path.exists(full) or os.path.getsize(full) == 0
        with open(full, "ab") as fh:
            fh.write((header if is_new else b"") + b"".join(t for _, t in new))
            fh.flush()
            os.fsync(fh.fileno())
        written[key] = max(i for i, _ in new)
        save_state(root, state)
        count += len(new)
    return count


def open_path(root, rel):
    target = safe_path(root, rel) if rel else root
    if not os.path.exists(target):
        target = root
    if sys.platform == "win32":
        os.startfile(target)  # noqa: S606 - opens Explorer on the user's own log folder
    elif sys.platform == "darwin":
        subprocess.Popen(["open", target])
    else:
        subprocess.Popen(["xdg-open", target])


def handle(msg):
    kind = msg.get("type")
    root = log_root(msg.get("folder"))
    if kind == "hello":
        return {"ok": True, "version": VERSION, "folder": root}
    if kind == "append":
        log_id = str(msg.get("log") or "default")[:100]
        return {"ok": True, "written": append_files(root, log_id, msg.get("files") or []), "folder": root}
    if kind == "open":
        open_path(root, msg.get("path"))
        return {"ok": True}
    return {"ok": False, "error": "unknown message type: %r" % kind}


def read_message(stream):
    raw = stream.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    if length > MAX_MESSAGE:
        raise ValueError("message too large")
    data = stream.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(stream, obj):
    data = json.dumps(obj).encode("utf-8")
    stream.write(struct.pack("<I", len(data)))
    stream.write(data)
    stream.flush()


def main():
    if sys.platform == "win32":
        import msvcrt

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    while True:
        try:
            msg = read_message(stdin)
        except Exception as e:  # malformed input: answer once, then stop
            send_message(stdout, {"ok": False, "error": "bad message: %s" % e})
            return
        if msg is None:
            return
        try:
            reply = handle(msg if isinstance(msg, dict) else {})
        except Exception as e:
            reply = {"ok": False, "error": str(e)}
        send_message(stdout, reply)


if __name__ == "__main__":
    main()
