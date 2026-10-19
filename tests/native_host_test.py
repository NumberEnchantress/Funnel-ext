"""Round-trip tests for the native file writer, speaking the same framed protocol Firefox uses."""
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "native", "otaat_host.py")


def run(*messages):
    data = b""
    for m in messages:
        body = json.dumps(m).encode("utf-8")
        data += struct.pack("<I", len(body)) + body
    proc = subprocess.run([sys.executable, "-I", "-u", HOST], input=data, capture_output=True, timeout=20)
    out, replies = proc.stdout, []
    while out:
        (n,) = struct.unpack("<I", out[:4])
        replies.append(json.loads(out[4 : 4 + n].decode("utf-8")))
        out = out[4 + n :]
    return replies, proc


class NativeHostTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = os.path.join(self.tmp.name, "logs with spaces ü")

    def tearDown(self):
        self.tmp.cleanup()

    def test_hello_creates_folder(self):
        replies, _ = run({"type": "hello", "folder": self.folder})
        self.assertTrue(replies[0]["ok"])
        self.assertEqual(os.path.abspath(replies[0]["folder"]), os.path.abspath(self.folder))
        self.assertTrue(os.path.isdir(self.folder))

    def append(self, files, log="log-1"):
        return run({"type": "append", "folder": self.folder, "log": log, "files": files})[0][0]

    def read(self, *parts):
        with open(os.path.join(self.folder, *parts), encoding="utf-8") as fh:
            return fh.read()

    def test_append_writes_header_once_and_appends(self):
        f = {"path": "2026-10/skipped.md", "header": "# Skipped\n\n", "lines": [[1, "- one\n"]]}
        self.assertTrue(self.append([f])["ok"])
        self.assertTrue(self.append([dict(f, lines=[[2, "- two ✓\n"]])])["ok"])
        self.assertEqual(self.read("2026-10", "skipped.md"), "# Skipped\n\n- one\n- two ✓\n")

    def test_resending_lines_never_duplicates(self):
        f = {"path": "s.md", "header": "", "lines": [[1, "a\n"], [2, "b\n"]]}
        self.append([f])
        self.append([dict(f, lines=[[1, "a\n"], [2, "b\n"], [3, "c\n"]])])
        self.assertEqual(self.read("s.md"), "a\nb\nc\n")
        # A different browser log (e.g. after a reinstall, ids start again) is not skipped.
        self.append([dict(f, lines=[[1, "new a\n"]])], log="log-2")
        self.assertEqual(self.read("s.md"), "a\nb\nc\nnew a\n")

    def test_locked_file_then_retry_writes_each_line_once(self):
        # One file can't be written (e.g. open in Excel): the batch fails, the retry must not repeat the others.
        os.makedirs(self.folder, exist_ok=True)
        blocked = os.path.join(self.folder, "events.jsonl")
        os.makedirs(blocked)  # a folder where the file should be: appending to it fails
        batch = [{"path": "skipped.md", "header": "", "lines": [[5, "Post A\n"]]}, {"path": "events.jsonl", "header": "", "lines": [[5, "{}\n"]]}]
        for _ in range(3):
            self.assertFalse(self.append(batch)["ok"])
        os.rmdir(blocked)
        self.assertTrue(self.append(batch)["ok"])
        self.assertEqual(self.read("skipped.md"), "Post A\n")
        self.assertEqual(self.read("events.jsonl"), "{}\n")

    def test_half_an_emoji_does_not_break_writing(self):
        # Firefox sends lone surrogates as \\udXXX escapes inside the JSON.
        body = '{"type":"append","folder":%s,"log":"x","files":[{"path":"a.md","header":"","lines":[[1,"ok \\ud83d end\\n"]]}]}' % json.dumps(self.folder)
        data = body.encode("utf-8")
        proc = subprocess.run([sys.executable, "-I", "-u", HOST], input=struct.pack("<I", len(data)) + data, capture_output=True, timeout=20)
        (n,) = struct.unpack("<I", proc.stdout[:4])
        self.assertTrue(json.loads(proc.stdout[4 : 4 + n])["ok"])
        self.assertEqual(self.read("a.md"), "ok ? end\n")

    def test_bad_path_in_batch_writes_nothing(self):
        files = [{"path": "good.md", "lines": [[1, "x\n"]]}, {"path": "../bad.md", "lines": [[1, "y\n"]]}]
        self.assertFalse(self.append(files)["ok"])
        self.assertFalse(os.path.exists(os.path.join(self.folder, "good.md")), "nothing written from a rejected batch")

    def test_bookkeeping_file_is_off_limits(self):
        self.assertFalse(self.append([{"path": ".otaat-state.json", "lines": [[1, "{}"]]}])["ok"])

    def test_never_overwrites(self):
        self.append([{"path": "a/b.md", "lines": [[1, "old\n"]]}])
        replies, _ = run({"type": "write", "folder": self.folder, "files": [{"path": "a/b.md", "text": "new\n"}]})
        self.assertFalse(replies[0]["ok"], "there is no overwrite command")
        with open(os.path.join(self.folder, "a", "b.md"), encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "old\n")

    def test_refuses_paths_outside_the_folder(self):
        for bad in ["../evil.md", "a/../../evil.md", "/etc/passwd", "C:/Windows/evil.md", "..\\evil.md", ""]:
            self.assertFalse(self.append([{"path": bad, "lines": [[1, "x"]]}])["ok"], bad)
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "evil.md")))

    def test_default_folder_comes_from_the_installer_config(self):
        # A copy of the host with the config file the installer writes next to it.
        install = os.path.join(self.tmp.name, "install")
        os.makedirs(install)
        host = os.path.join(install, "otaat_host.py")
        with open(HOST, encoding="utf-8") as src, open(host, "w", encoding="utf-8") as dst:
            dst.write(src.read())
        chosen = os.path.join(self.tmp.name, "OTAAT")
        with open(os.path.join(install, "otaat_host_config.json"), "w", encoding="utf-8-sig") as fh:
            json.dump({"folder": chosen}, fh)
        body = json.dumps({"type": "hello", "folder": ""}).encode("utf-8")
        proc = subprocess.run([sys.executable, "-I", "-u", host], input=struct.pack("<I", len(body)) + body, capture_output=True, timeout=20)
        (n,) = struct.unpack("<I", proc.stdout[:4])
        reply = json.loads(proc.stdout[4 : 4 + n])
        self.assertEqual(os.path.normcase(reply["folder"]), os.path.normcase(os.path.abspath(chosen)))
        self.assertTrue(os.path.isdir(chosen))

    def test_unknown_type_and_bad_input(self):
        replies, _ = run({"type": "format-disk"})
        self.assertFalse(replies[0]["ok"])
        proc = subprocess.run([sys.executable, "-I", "-u", HOST], input=struct.pack("<I", 5) + b"nope!", capture_output=True, timeout=20)
        (n,) = struct.unpack("<I", proc.stdout[:4])
        self.assertFalse(json.loads(proc.stdout[4 : 4 + n])["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
