#!/usr/bin/env python3
"""SegForces: a local Codeforces-style judge UI for the Practice-* course repo.

    python3 segforces/server.py            # finds the repo next to this folder
    python3 segforces/server.py --open     # ...and opens the browser
    python3 segforces/server.py --repo PATH --port 7331

Standard library only (Python 3.8+). Listens on 127.0.0.1 only; every API call
must carry the per-launch token that is baked into the served page, so other
websites open in the same browser cannot drive it.

The only thing that ever leaves the machine is an explicit, user-confirmed
"Submit": a commit of the selected solution files of ONE task with the message
"GRADER\\n<SessionXX/task>" pushed to origin/master (same format as `make submit`).
"""
from __future__ import annotations

import argparse
import concurrent.futures
import csv
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DEFAULT_PORT = 7331
VERSION = "1.1"


class ApiError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


# ---------------------------------------------------------------------------
# process / file helpers
# ---------------------------------------------------------------------------

def augment_path():
    """Make CLI tools findable even when started from Finder or an IDE."""
    home = Path.home()
    extra = [
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        "/Applications/Docker.app/Contents/Resources/bin",
        str(home / ".local/bin"), str(home / ".claude/local"), str(home / ".npm-global/bin"),
    ]
    extra += [str(p) for p in sorted(home.glob(".nvm/versions/node/*/bin"), reverse=True)]
    parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    for p in extra:
        if p not in parts and os.path.isdir(p):
            parts.append(p)
    os.environ["PATH"] = os.pathsep.join(parts)


def _dec(data):
    return (data or b"").decode("utf-8", "replace")


def kill_tree(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except OSError:
            pass


def run_cmd(args, cwd=None, timeout=30.0, env=None, input_text=None):
    """Run a command to completion. Never raises; returns (code, stdout, stderr)."""
    args = [str(a) for a in args]
    try:
        proc = subprocess.Popen(
            args, cwd=cwd, env=env,
            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
        )
    except FileNotFoundError:
        return 127, "", "not found: %s" % args[0]
    except OSError as exc:
        return 126, "", str(exc)
    data = input_text.encode("utf-8") if input_text is not None else None
    try:
        out, err = proc.communicate(data, timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        try:
            out, err = proc.communicate(timeout=5)
        except Exception:
            out, err = b"", b""
        return 124, _dec(out), _dec(err) + "\n[timeout after %ss]" % int(timeout)
    return proc.returncode, _dec(out), _dec(err)


ETIMEDOUT = getattr(__import__("errno"), "ETIMEDOUT", 60)
SF_DATALESS = 0x40000000  # macOS st_flags bit: file content evicted by a cloud-sync provider
READ_TIMEOUT = 12.0
_read_pool = concurrent.futures.ThreadPoolExecutor(max_workers=24, thread_name_prefix="read")


def _read_bytes_sync(path, limit):
    last = None
    for attempt in range(3):
        try:
            with open(str(path), "rb") as fh:
                return fh.read(limit) if limit else fh.read()
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
            raise
        except OSError as exc:
            last = exc
            if exc.errno == ETIMEDOUT:  # the provider could not fetch it; retrying just waits again
                break
            time.sleep(0.3 * (attempt + 1))
    raise last


def read_bytes(path, limit=None, timeout=READ_TIMEOUT):
    """Read a file without ever hanging the caller.

    A read() of an evicted (cloud-synced) file can block for minutes while the download stalls,
    and a blocked syscall cannot be interrupted, so the read runs in a worker thread
    and the caller gives up after `timeout` seconds."""
    fut = _read_pool.submit(_read_bytes_sync, path, limit)
    try:
        return fut.result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        raise OSError(ETIMEDOUT, "файл не прочитался за %d с" % timeout, str(path))


def is_dataless(path):
    try:
        return bool(getattr(os.lstat(str(path)), "st_flags", 0) & SF_DATALESS)
    except OSError:
        return False


def read_text(path, limit=None):
    return read_bytes(path, limit).decode("utf-8", "replace")


def sha1(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha1(data).hexdigest()


def is_binary(path):
    try:
        return b"\0" in read_bytes(path, 8192)
    except OSError:
        return True


def tail_lines(text, n):
    lines = text.splitlines()
    return "\n".join(lines[-n:])


def load_json_file(path):
    """Parsed JSON, or None if the file does not exist.

    Corrupt JSON is moved aside (kept for inspection). Any other read error is raised:
    callers must not treat "could not read" as "empty" and then overwrite real data."""
    try:
        return json.loads(read_text(path))
    except FileNotFoundError:
        return None
    except ValueError:
        try:
            os.replace(str(path), "%s.corrupt-%d" % (path, int(time.time())))
        except OSError:
            pass
        return None


class JsonStore:
    def __init__(self, path, default):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.data = default
        self.broken = None
        try:
            loaded = load_json_file(self.path)
            if isinstance(loaded, dict) and isinstance(default, dict):
                self.data = dict(default, **loaded)
        except OSError as exc:
            self.broken = str(exc)
            log("[store] не читается %s (%s) — в этой сессии изменения в него не пишутся" % (self.path, exc))

    def save(self):
        with self.lock:
            if self.broken:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(json.dumps(self.data, ensure_ascii=False), "utf-8")
            os.replace(str(tmp), str(self.path))


def segforces_home():
    """SEGFORCES_HOME=/some/dir keeps config and data there (portable installs, tests)."""
    env = os.environ.get("SEGFORCES_HOME")
    return Path(env).expanduser() if env else None


def default_data_dir(repo_root):
    """Per-repo state, kept outside the repo (and outside synced folders like ~/Documents)."""
    if segforces_home():
        return segforces_home() / "data" / Path(repo_root).name
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "SegForces"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "segforces"
    return base / Path(repo_root).name


def config_dir():
    if segforces_home():
        return segforces_home()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "SegForces"
    return Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config")) / "segforces"


# ---------------------------------------------------------------------------
# repository model: sessions, tasks, files
# ---------------------------------------------------------------------------

SESSION_RE = re.compile(r"^Session(\d+)$")
TASK_KEY_RE = re.compile(r"^Session\d+/[A-Za-z0-9_.\-]+$")
HIDDEN_DIRS = {
    "open_tests", ".hidden_tests", "hidden_tests", ".git", "__pycache__", ".idea", ".vscode",
    "thirdparty", "third_party", "node_modules", "cmake_build", ".cache",
}
HIDDEN_FILES = {"run_test.sh", "run_tests.sh", "YOUR_CODE_HERE", ".DS_Store", ".gitkeep"}
PROTECTED_TOP = {"open_tests", ".hidden_tests", "hidden_tests", ".git"}
MAX_TEXT = 1024 * 1024
ARTIFACT_RE = re.compile(
    r"(^|/)(build|cmake_build|cmake-build-[^/]*)(/|$)|\.(o|a|so|dylib|out|gch|pyc|d)$")
LANG_BY_EXT = {
    ".sh": "shell", ".bash": "shell", ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp",
    ".hpp": "cpp", ".py": "python", ".md": "markdown", ".json": "json", ".yml": "yaml",
    ".yaml": "yaml", ".txt": "plaintext", ".conf": "plaintext", ".log": "plaintext",
    ".csv": "plaintext", ".pc": "plaintext", ".in": "plaintext",
}
MOUNT_RE = re.compile(r'-v\s+"\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)/([^":]+):([^"]+)"')
IMAGE_RE = re.compile(r"docker build\s+-t\s+(\S+)")
CODE_SPAN_RE = re.compile(r"`([^`\n]+)`")
FENCE_RE = re.compile(r"^```.*?^```", re.S | re.M)
CAND_RE = re.compile(r"^(?:\./)?((?:[\w.-]+/)*[\w-][\w.-]*\.(?:sh|c|h|cpp|hpp|py)|Makefile\.Student)$")
EXAMPLE_RE = re.compile(r"^\$ (\./\S.*?)\s*$", re.M)
MAKE_TARGET_PY = re.compile(r'\[\s*(?:self|cls)\.make\s*,\s*"-f"\s*,\s*(?:self|cls)\.makefile\s*,\s*"([^"]+)"', re.S)
MAKE_TARGET_SH = re.compile(r"make -f Makefile\.Student\s+([\w.\-]+)")
NON_BUILD_TARGETS = {"clean", "install", "uninstall", "fclean", "distclean"}


def lang_for(path):
    base = path.rsplit("/", 1)[-1]
    if base.startswith("Makefile") or base == "makefile" or base.endswith(".mk"):
        return "makefile"
    if base == "Dockerfile":
        return "dockerfile"
    if base == "CMakeLists.txt":
        return "cmake"
    return LANG_BY_EXT.get(os.path.splitext(base)[1].lower(), "plaintext")


def is_readme(name):
    return name.lower() in ("readme.md", "readme")


def is_protected_rel(rel):
    """Part of the statement/tests, never written or committed. rel is relative to the
    task dir and already normalized; compared case-insensitively (APFS is case-insensitive)."""
    parts = [x.lower() for x in Path(rel).parts]
    if not parts:
        return True
    if parts[0] in {x.lower() for x in PROTECTED_TOP}:
        return True
    return len(parts) == 1 and (is_readme(parts[0]) or parts[0] in ("run_test.sh", "run_tests.sh"))


def parse_grading(path):
    out, cur = {}, None
    try:
        text = read_text(path)
    except OSError:
        return out
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        line = raw.rstrip()
        if not raw[0].isspace() and line.endswith(":"):
            cur = line[:-1].strip()
            out[cur] = {}
        elif cur is not None and ":" in line:
            k, v = line.strip().split(":", 1)
            v = v.strip().strip("\"'")
            out[cur][k.strip()] = int(v) if re.fullmatch(r"-?\d+", v) else v
    return out


def readme_title(text, fallback):
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("# "):
            t = s[2:].strip()
            t = re.sub(r"\s*\(\s*`?[\w./-]+\.(?:sh|c|h|cpp|py)`?\s*\)\s*$", "", t)
            t = t.replace("`", "").strip()
            return t or fallback
    return fallback


def parse_runner(text):
    open_part = re.split(r"\n\s*else\b", text, maxsplit=1)[0]
    image = IMAGE_RE.search(open_part)
    return {
        "docker": bool(re.search(r"\bdocker\s+(run|build)\b", open_part)),
        "image": image.group(1) if image else None,
        "mounts": [(s, d) for s, d in MOUNT_RE.findall(open_part)],
    }


class Repo:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.lock = threading.Lock()
        self._sessions = None
        self._sessions_at = 0.0
        self._titles = {}
        self._health = None
        self._health_at = 0.0

    def health(self, force=False):
        """Can we actually read files? A stuck cloud-sync provider can make every read hang."""
        if not force and self._health and time.time() - self._health_at < 20:
            return self._health
        # Probe a file whose content is evicted: that is exactly what fails when syncing is stuck.
        candidates = sorted(self.root.glob("Session*/grading.yml")) + \
            sorted(self.root.glob("Session*/*/[Rr][Ee][Aa][Dd][Mm][Ee].md"))
        sample = next((p for p in candidates if is_dataless(p)), None)
        result = {"ok": True, "dataless": sample is not None}
        if sample is not None:
            try:
                read_bytes(sample, 256, timeout=8)
            except OSError as exc:
                result = {"ok": False, "dataless": True,
                          "error": "%s: %s" % (sample.relative_to(self.root), exc.strerror or exc)}
        self._health = result
        self._health_at = time.time()
        if not result["ok"]:
            self._sessions = None
        return result

    # -- sessions & tasks ------------------------------------------------
    def sessions(self, force=False):
        with self.lock:
            if not force and self._sessions is not None and time.time() - self._sessions_at < 4:
                return self._sessions
        healthy = self.health()["ok"]
        sessions = []
        try:
            entries = sorted(self.root.iterdir())
        except OSError:
            entries = []
        session_dirs = []
        for d in entries:
            m = SESSION_RE.match(d.name)
            if m and d.is_dir():
                session_dirs.append((int(m.group(1)), d))
        session_dirs.sort()
        readmes = []
        for num, sdir in session_dirs:
            grading = parse_grading(sdir / "grading.yml") if healthy else {}
            names = set(grading)
            try:
                for d in sdir.iterdir():
                    if d.is_dir() and not d.name.startswith("."):
                        names.add(d.name)
            except OSError:
                pass
            tasks = []
            for name in names:
                tdir = sdir / name
                g = grading.get(name, {})
                task = {
                    "key": "%s/%s" % (sdir.name, name),
                    "session": sdir.name,
                    "snum": num,
                    "name": name,
                    "title": self._titles.get("%s/%s" % (sdir.name, name)) or name.replace("_", " ").capitalize(),
                    "points": g.get("points"),
                    "id": g.get("id"),
                    "deadline": g.get("deadline"),
                    "exists": tdir.is_dir(),
                }
                tasks.append(task)
                if task["key"] not in self._titles and task["exists"]:
                    readmes.append(task)
            tasks.sort(key=lambda t: (t["id"] is None, t["id"] or 0, t["name"]))
            for i, t in enumerate(tasks):
                t["letter"] = chr(ord("A") + i) if i < 26 else str(i + 1)
            deadlines = [t["deadline"] for t in tasks if t["deadline"]]
            sessions.append({
                "name": sdir.name, "num": num, "tasks": tasks,
                "deadline": min(deadlines) if deadlines else None,
                "points": sum(t["points"] or 0 for t in tasks),
            })
        if readmes and healthy:
            self._load_titles(readmes)
        with self.lock:
            self._sessions = sessions
            self._sessions_at = time.time()
        return sessions

    def _load_titles(self, tasks):
        """Fill titles from ReadMe headings; never wait more than a few seconds in total."""
        def one(task):
            readme = self.find_readme(self.root / task["key"])
            if not readme:
                return task, None
            try:
                title = readme_title(read_text(readme, 4096), None)
            except OSError:
                return task, None
            if title:
                self._titles[task["key"]] = title  # late results still warm the cache
            return task, title
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=12)
        futs = [pool.submit(one, t) for t in tasks]
        done, _pending = concurrent.futures.wait(futs, timeout=6)
        for fut in done:
            task, title = fut.result()
            if title:
                task["title"] = title
        pool.shutdown(wait=False)

    def all_tasks(self):
        return [t for s in self.sessions() for t in s["tasks"]]

    def task(self, key):
        if not key or not TASK_KEY_RE.match(key):
            raise ApiError(400, "Некорректный ключ задачи: %r" % key)
        for t in self.all_tasks():
            if t["key"] == key:
                return t
        raise ApiError(404, "Задача %s не найдена" % key)

    def task_dir(self, key):
        self.task(key)
        root = self.root.resolve()  # re-resolved: the repo may have been moved behind a symlink
        tdir = (root / key).resolve()
        if not str(tdir).startswith(str(root) + os.sep) or not tdir.is_dir():
            raise ApiError(404, "Папка задачи %s не найдена" % key)
        return tdir

    @staticmethod
    def find_readme(tdir):
        try:
            for f in sorted(tdir.iterdir()):
                if is_readme(f.name) and f.is_file():
                    return f
        except OSError:
            pass
        return None

    def runner(self, tdir):
        for name in ("run_test.sh", "run_tests.sh"):
            p = tdir / name
            if p.is_file():
                try:
                    info = parse_runner(read_text(p))
                except OSError:
                    info = {"docker": False, "image": None, "mounts": []}
                info["script"] = name
                return info
        return None

    def safe_path(self, key, rel, for_write=False):
        tdir = self.task_dir(key)
        rel = (rel or "").strip().lstrip("/")
        if not rel or "\0" in rel:
            raise ApiError(400, "Пустой путь")
        p = (tdir / rel).resolve()
        if not str(p).startswith(str(tdir) + os.sep):
            raise ApiError(400, "Путь выходит за пределы папки задачи")
        if for_write and is_protected_rel(str(p.relative_to(tdir))):
            raise ApiError(403, "Этот файл — часть условия/тестов, его менять нельзя")
        return p

    # -- task details ----------------------------------------------------
    def solution_files(self, tdir):
        files = []
        for root, dirs, names in os.walk(str(tdir)):
            rel_root = os.path.relpath(root, str(tdir))
            dirs[:] = sorted(d for d in dirs if d not in HIDDEN_DIRS and not d.startswith("cmake-build"))
            for n in sorted(names):
                if n in HIDDEN_FILES or (rel_root == "." and is_readme(n)):
                    continue
                rel = n if rel_root == "." else "%s/%s" % (rel_root, n)
                full = Path(root) / n
                try:
                    st = full.lstat()
                except OSError:
                    continue
                if not stat.S_ISREG(st.st_mode):
                    continue
                binary = st.st_size > MAX_TEXT or is_binary(full)
                files.append({
                    "path": rel, "size": st.st_size, "exec": bool(st.st_mode & 0o111),
                    "binary": binary, "artifact": binary or bool(ARTIFACT_RE.search(rel)),
                    "lang": lang_for(rel), "mtime": st.st_mtime,
                })
        return files

    def test_files(self, tdir):
        out = []
        base = tdir / "open_tests"
        if not base.is_dir():
            return out
        for root, dirs, names in os.walk(str(base)):
            dirs[:] = sorted(d for d in dirs if d != "__pycache__")
            for n in sorted(names):
                full = Path(root) / n
                rel = os.path.relpath(str(full), str(tdir))
                try:
                    size = full.stat().st_size
                except OSError:
                    continue
                out.append({"path": rel, "size": size, "lang": lang_for(rel)})
        return out

    def make_targets(self, tdir):
        """make targets the open tests build, e.g. ['liblist.so'] — in test order."""
        found = []
        base = tdir / "open_tests"
        if not base.is_dir():
            return found
        for f in sorted(base.iterdir()):
            if not f.is_file() or f.suffix not in (".py", ".sh"):
                continue
            try:
                text = read_text(f, 400000)
            except OSError:
                continue
            for t in MAKE_TARGET_PY.findall(text) + MAKE_TARGET_SH.findall(text):
                if t not in found and t not in NON_BUILD_TARGETS:
                    found.append(t)
        return found

    def expected_files(self, tdir, readme_text, runner):
        exp = {}
        src_mount = False
        mounts = (runner or {}).get("mounts") or []
        for src, _dst in mounts:
            src = src.strip("/")
            if not src or src.split("/")[0] in PROTECTED_TOP:
                continue
            base = src.rsplit("/", 1)[-1]
            if "." in base or base.startswith("Makefile"):
                exp[src] = "file"
            else:
                exp[src] = "dir"
                src_mount = src_mount or src == "src"
        text = FENCE_RE.sub("", readme_text or "")
        for span in CODE_SPAN_RE.findall(text):
            m = CAND_RE.match(span.strip())
            if not m:
                continue
            p = m.group(1)
            if p in HIDDEN_FILES:
                continue
            if mounts:
                if not (src_mount and (p.startswith("src/") or p == "Makefile.Student")):
                    continue
            elif "/" in p:
                continue
            exp.setdefault(p, "file")
        out = []
        for p, kind in exp.items():
            full = tdir / p
            out.append({"path": p, "kind": kind, "exists": full.exists(), "is_dir": full.is_dir()})
        return out

    def task_detail(self, key):
        task = dict(self.task(key))
        tdir = self.task_dir(key)
        health = self.health()
        if not health["ok"]:
            raise ApiError(503, "Файлы репозитория сейчас не читаются: папка недоступна или отдаёт файлы очень медленно. "
                                "Подожди немного и обнови страницу.",
                           code="unreadable", detail=health.get("error"))
        readme = self.find_readme(tdir)
        statement = ""
        if readme:
            try:
                statement = read_text(readme)
            except OSError as exc:
                statement = "_Не удалось прочитать условие: %s_" % exc
        runner = self.runner(tdir)
        files = self.solution_files(tdir)
        for f in files:
            if not f["binary"]:
                try:
                    f["hash"] = sha1(read_bytes(tdir / f["path"]))
                except OSError:
                    f["hash"] = None
        expected = self.expected_files(tdir, statement, runner)
        kinds = set(f["lang"] for f in files) | set(lang_for(e["path"]) for e in expected)
        if runner and any(e["path"] == "src" for e in expected):
            kinds.add("c")
        task.update({
            "statement": statement,
            "readme": readme.name if readme else None,
            "files": files,
            "expected": expected,
            "tests": self.test_files(tdir),
            "runner": runner,
            "kind": "c" if ("c" in kinds or "cpp" in kinds or "makefile" in kinds) else ("bash" if "shell" in kinds else "other"),
            "make_targets": self.make_targets(tdir),
            "example": (EXAMPLE_RE.search(statement).group(1) if EXAMPLE_RE.search(statement) else None),
            "dir": str(tdir),
        })
        return task


# ---------------------------------------------------------------------------
# output analysis: verdicts, failed tests, human hints
# ---------------------------------------------------------------------------

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
TS_RE = re.compile(r"^\ufeff?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?")
UT_RAN = re.compile(r"^Ran (\d+) tests? in ([\d.]+)s", re.M)
UT_RESULT = re.compile(r"^(OK|FAILED)\b(?: \(([^)]*)\))?\s*$", re.M)
UT_BLOCK = re.compile(r"^(FAIL|ERROR): (\S+) \(([^)]*)\)\s*$", re.M)
UT_PROGRESS = re.compile(r"^[.FEsxu]+$")
EXC_LINE = re.compile(
    r"^(?:[A-Za-z_][\w.]*\.)?[A-Z]\w*(?:Error|Exception|Exit|Interrupt|Expired)\b.*$", re.M)
GT_OK = re.compile(r"^\[\s+OK\s+\] (\S+)", re.M)
GT_FAILED = re.compile(r"^\[\s+FAILED\s+\] (\S+?)(?: \(\d+ ms\))?\s*$", re.M)
GT_PASSED_SUM = re.compile(r"^\[\s+PASSED\s+\] (\d+) tests?", re.M)
GCC_ERR = re.compile(r"^(\S+?):(\d+):(?:(\d+):)? (?:fatal )?error: (.+)$", re.M)

VERDICT_NAMES = {
    "AC": "Accepted", "WA": "Wrong answer", "RE": "Runtime error", "CE": "Compilation error",
    "TLE": "Time limit exceeded", "JE": "Judge error", "OFFLINE": "Docker не запущен",
    "CANCELLED": "Отменено", "BLOCKED": "Не запущено", "TESTING": "Testing…", "QUEUED": "In queue",
}

HINT_RULES = [
    (r"Exec format error", "error", "Нет shebang",
     "Первая строка скрипта должна быть `#!/bin/bash`. Без неё Python (`subprocess`) не знает, чем запускать файл, и падает с `Exec format error`.",
     "fix_shebang"),
    (r"bad interpreter", "error", "Неверный shebang",
     "Интерпретатора из строки `#!` нет в окружении тестов. Используй `#!/bin/bash`.", "fix_shebang"),
    (r"Permission denied: '[^']*\.sh'|\.sh: Permission denied|PermissionError: \[Errno 13\]", "error",
     "Нет прав на запуск",
     "Скрипт не помечен как исполняемый. Нужен `chmod +x`; git сохранит этот бит при коммите.", "chmod"),
    (r"\$'\\r': command not found|\r': command not found|\^M|\\r: command not found", "error",
     "Windows-переводы строк (CRLF)",
     "В файле окончания строк `\\r\\n`, bash считает `\\r` частью команды. Переведи файл в LF.", "fix_crlf"),
    (r"Cannot connect to the Docker daemon|Is the docker daemon running|docker daemon is not running|error during connect",
     "warn", "Docker не запущен", "Тесты гоняются в контейнере. Запусти Docker Desktop и повтори.", "start_docker"),
    (r"No rule to make target '([^']+)'", "error", "Нет цели в Makefile",
     "make не знает, как получить `{0}`. Проверь имена целей в `Makefile.Student` (`build`, `clean`, имя библиотеки…).", None),
    (r"\*\*\* missing separator", "error", "Пробелы вместо TAB в Makefile",
     "Команды рецепта в Makefile должны начинаться с табуляции, а не с пробелов.", None),
    (r"undefined reference to `([^']+)'", "error", "Ошибка линковки",
     "Линковщик не нашёл `{0}`: функция не определена, её .c-файл не участвует в сборке или не подключена библиотека (`-lm`, `-pthread`).", None),
    (r"implicit declaration of function '([^']+)'", "warn", "Нет объявления функции",
     "`{0}` вызывается без объявления: подключи нужный заголовок или объяви прототип.", None),
    (r"Segmentation fault|SIGSEGV|signal 11\b|core dumped|exit code 139|returncode -11|returned -11|status -11",
     "error", "Segmentation fault",
     "Обращение к невалидной памяти: NULL-указатель, выход за границы массива, use-after-free, бесконечная рекурсия. Собери с `-g -fsanitize=address` или прогони через `valgrind`.", None),
    (r"double free|free\(\): invalid|malloc\(\): corrupted|heap-buffer-overflow|stack-buffer-overflow|AddressSanitizer",
     "error", "Порча памяти",
     "Двойной `free`, запись за границы буфера или похожее. `-g -fsanitize=address` покажет точное место.", None),
    (r"FileNotFoundError: \[Errno 2\] No such file or directory: '([^']+)'", "warn", "Файл не найден",
     "Тест не нашёл `{0}`. Возможно, программа не собралась, файл назван иначе или лежит не в той папке.", None),
    (r"(?m)(?:^|: )(?:line \d+: )?([\w.\-]+): command not found", "error", "Команда не найдена",
     "`{0}` нет в окружении тестов (Debian slim): опечатка или нестандартная утилита.", None),
    (r"syntax error near unexpected token|syntax error: unexpected end of file", "error",
     "Синтаксическая ошибка bash",
     "Проверь пары `if/fi`, `do/done`, `case/esac`, `{ }` и закрытые кавычки.", None),
    (r"\[\[: not found|\[: missing `\]'|too many arguments|unary operator expected|binary operator expected",
     "warn", "Проблема с [ ] / [[ ]]",
     "Нужны пробелы внутри скобок: `[[ $a == b ]]`. «unary operator expected» и «too many arguments» обычно значат переменную без кавычек: пустую или с пробелами.", None),
    (r"integer expression expected", "warn", "Не число в сравнении",
     "`-eq/-lt/-gt` работают только с целыми числами. Проверь, что в переменной именно число.", None),
    (r"unbound variable", "warn", "Незаданная переменная",
     "С `set -u` обращение к пустой переменной роняет скрипт. Проверь `$#` перед `$1`.", None),
    (r"TimeoutExpired|timed out after", "warn", "Слишком долго",
     "Программа зависла или ждёт ввода: `read` без данных, бесконечный цикл, ожидание сети.", None),
    (r"\bKilled\b|exit code 137|OOMKilled|MemoryError", "warn", "Процесс убит",
     "Скорее всего, кончилась память или сработал таймаут.", None),
    (r"Makefile\.Student: Is a directory|Is a directory: '[^']*Makefile|mounts denied", "warn",
     "Папка вместо файла",
     "Если файла решения нет, Docker создаёт на его месте пустую папку. Удали её и создай файл.", None),
    (r"failed to solve|failed to fetch|Temporary failure resolving|Could not resolve host|TLS handshake timeout",
     "warn", "Проблема со сборкой образа",
     "Docker не собрал тестовый образ. Обычно это сеть или apt. Проверь интернет и повтори.", None),
    (r"AssertionError", "info", "Вывод не совпал",
     "Тест сравнил вывод с ожидаемым. Посмотри во вкладке «Тесты», что именно проверяется. В диффе `-` — первый аргумент `assertEqual`, `+` — второй.", None),
]
HINT_RULES = [(re.compile(p), lvl, title, text, action) for p, lvl, title, text, action in HINT_RULES]


def exc_message(body):
    ms = list(EXC_LINE.finditer(body))
    if ms:
        msg = body[ms[-1].start():].strip()
    else:
        msg = "\n".join(body.strip().splitlines()[-8:])
    lines = msg.splitlines()
    if len(lines) > 40:
        lines = lines[:40] + ["…"]
    return "\n".join(lines)


def parse_unittest(t):
    rans = list(UT_RAN.finditer(t))
    if not rans:
        return None
    total = sum(int(m.group(1)) for m in rans)
    failures = errors = skipped = 0
    for _status, details in UT_RESULT.findall(t):
        for part in (details or "").split(","):
            k, _, v = part.strip().partition("=")
            if not v.isdigit():
                continue
            if k == "failures" or k == "unexpected successes":
                failures += int(v)
            elif k == "errors":
                errors += int(v)
            elif k == "skipped":
                skipped += int(v)
    blocks = []
    hdrs = list(UT_BLOCK.finditer(t))
    for i, m in enumerate(hdrs):
        end = hdrs[i + 1].start() if i + 1 < len(hdrs) else len(t)
        nxt = [r.start() for r in rans if r.start() > m.end()]
        if nxt:
            end = min(end, nxt[0])
        body = re.sub(r"^[-=]{20,}\s*$", "", t[m.end():end], flags=re.M).strip("\n")
        where = m.group(3)
        blocks.append({
            "kind": "WA" if m.group(1) == "FAIL" else "RE",
            "name": m.group(2), "where": where,
            "hidden": "hidden" in where,
            "message": exc_message(body),
            "trace": body[-6000:],
        })
    seq = None
    head = t[:rans[0].start()]
    for line in reversed(head.splitlines()):
        s = line.strip()
        if s and UT_PROGRESS.match(s):
            seq = s
            break
    return {"framework": "unittest", "total": total, "failures": failures, "errors": errors,
            "skipped": skipped, "blocks": blocks, "seq": seq}


def parse_gtest(t):
    oks = GT_OK.findall(t)
    failed = []
    for name in GT_FAILED.findall(t):
        if name not in failed and not name.isdigit():
            failed.append(name)
    if not oks and not failed and not GT_PASSED_SUM.search(t):
        return None
    total = len(set(oks)) + len(failed)
    blocks = []
    for name in failed:
        idx = t.find("[ RUN      ] %s" % name)
        body = ""
        if idx >= 0:
            end = t.find("[  FAILED  ] %s" % name, idx)
            body = t[idx:end if end > idx else idx + 3000]
        blocks.append({"kind": "WA", "name": name, "where": name, "hidden": "hidden" in name.lower(),
                       "message": "\n".join(body.strip().splitlines()[-15:]), "trace": body[-6000:]})
    return {"framework": "gtest", "total": total, "failures": len(failed), "errors": 0, "skipped": 0,
            "blocks": blocks, "seq": None}


def collect_hints(t):
    hints, seen = [], set()
    for rx, level, title, text, action in HINT_RULES:
        m = rx.search(t)
        if not m or title in seen:
            continue
        seen.add(title)
        groups = [g for g in m.groups() if g] if m.groups() else []
        try:
            body = text.format(*groups) if groups else text.replace("{0}", "?")
        except (IndexError, KeyError):
            body = text
        hints.append({"level": level, "title": title, "text": body, "action": action})
    return hints


def analyze(text, exit_code, timed_out=False, cancelled=False):
    """Turn raw test-runner output into a Codeforces-like verdict."""
    t = ANSI_RE.sub("", text or "").replace("\r\n", "\n")
    res = {"verdict": None, "passed": None, "total": None, "first_failed": None,
           "failed": [], "hints": collect_hints(t), "framework": None, "note": None}
    parsed = parse_unittest(t) or parse_gtest(t)
    if parsed:
        res["framework"] = parsed["framework"]
        bad = parsed["failures"] + parsed["errors"]
        if parsed["framework"] == "gtest":
            bad = len(parsed["blocks"])
        res["total"] = parsed["total"]
        res["passed"] = max(parsed["total"] - bad - parsed["skipped"], 0)
        res["failed"] = parsed["blocks"]
        seq = parsed.get("seq")
        if seq and len(seq) == parsed["total"]:
            res["seq"] = seq
        if seq:
            for i, ch in enumerate(seq):
                if ch in "FEu":
                    res["first_failed"] = {"index": i + 1, "kind": "WA" if ch in "Fu" else "RE"}
                    break
        elif parsed["blocks"]:
            res["first_failed"] = {"index": None, "kind": parsed["blocks"][0]["kind"]}
    if cancelled:
        res["verdict"] = "CANCELLED"
    elif timed_out:
        res["verdict"] = "TLE"
    elif any(h["action"] == "start_docker" for h in res["hints"]):
        res["verdict"] = "OFFLINE"
    elif parsed:
        if parsed["total"] == 0:
            res["verdict"] = "JE"
            res["note"] = "Тесты не найдены"
        elif not res["failed"] and parsed["failures"] + parsed["errors"] == 0 and exit_code in (0, None):
            res["verdict"] = "AC"
        elif res["first_failed"]:
            res["verdict"] = res["first_failed"]["kind"]
        elif parsed["failures"]:
            res["verdict"] = "WA"
        else:
            res["verdict"] = "RE"
        if res["verdict"] == "RE" and GCC_ERR.search(t):
            res["verdict"] = "CE"
    else:
        if GCC_ERR.search(t) or "undefined reference to" in t or re.search(r"^make(\[\d+\])?: \*\*\*", t, re.M):
            res["verdict"] = "CE"
        elif re.search(r"failed to solve|ERROR: failed to build|failed to fetch", t):
            res["verdict"] = "JE"
            res["note"] = "Не собрался Docker-образ с тестами"
        elif exit_code == 0:
            res["verdict"] = "AC"
            res["note"] = "Формат вывода тестов не распознан, но код возврата 0"
        else:
            res["verdict"] = "RE"
    if res["verdict"] == "CE":
        errs = GCC_ERR.findall(t)
        res["compile_errors"] = ["%s:%s: %s" % (f, l, msg) for f, l, _c, msg in errs[:20]]
    if not parsed and res["verdict"] in ("RE", "WA"):
        # Custom checkers (e.g. "Error: factorial(0) returned , expected 1"): show what they printed.
        body = re.sub(r"^=+\s*(STDOUT|STDERR)\s*=+\s*$", "", t, flags=re.M)
        lines = [ln for ln in body.splitlines() if ln.strip() and not ln.startswith("[SegForces]")]
        if lines:
            msg = "\n".join(lines[-15:])
            if res["verdict"] == "RE" and re.search(r"expected|ожида|mismatch|!=", msg, re.I):
                res["verdict"] = "WA"
            res["failed"] = [{"kind": res["verdict"], "name": "вывод проверки", "where": "", "hidden": None,
                              "message": msg, "trace": msg}]
    res["verdict_name"] = VERDICT_NAMES.get(res["verdict"], res["verdict"])
    return res


DOCKER_PROBLEMS = {
    "stopped": ("Docker не запущен", "Тесты гоняются в контейнере. Запусти Docker Desktop (или `sudo systemctl start docker` на Linux) и повтори.", "start_docker"),
    "hung": ("Docker не отвечает", "Docker запущен, но не отвечает на запросы — такое бывает после сна или долгой работы. Перезапусти его: кнопка ниже или Troubleshoot → Restart в Docker Desktop.", "restart_docker"),
    "permission": ("Нет доступа к Docker", "Пользователю не хватает прав на docker.sock. Выполни `sudo usermod -aG docker $USER`, затем перелогинься (или `newgrp docker`).", None),
    "missing": ("Docker не установлен", "Без Docker тесты почти всех задач не запустятся. Поставь Docker Desktop (macOS/Windows) или Docker Engine (Linux).", None),
}


def docker_problem(state):
    title, text, action = DOCKER_PROBLEMS.get(state, DOCKER_PROBLEMS["stopped"])
    return {"level": "warn", "title": title, "text": text, "action": action}


def docker_offline_result(state):
    hint = docker_problem(state)
    return {"verdict": "OFFLINE", "verdict_name": hint["title"], "passed": None, "total": None,
            "first_failed": None, "failed": [], "hints": [hint], "note": None}


PARSER_VERSION = 2


def section_result(body, status):
    """Verdict for one task section of the grader log (status is PASSED/FAILED/...)."""
    passed = status == "PASSED"
    a = analyze(body, 0 if passed else 1)
    verdict = "AC" if passed else (a["verdict"] if a["verdict"] not in ("AC", None) else "WA")
    a["verdict"] = verdict
    a["verdict_name"] = VERDICT_NAMES.get(verdict, verdict)
    a["status"] = status
    a["log"] = body[-80000:]
    return a


def parse_grader_log(raw, tasks, conclusion):
    """Split a GitHub Actions job log of the grader into per-task results."""
    lines = [TS_RE.sub("", ln) for ln in (raw or "").splitlines()]
    start = 0
    for i, ln in enumerate(lines):
        if ln.startswith("COMMIT_MESSAGE (first 200 chars):"):
            start = i
    step = []
    for ln in lines[start:]:
        if ln.startswith("Post job cleanup"):
            break
        step.append(ln)
    sec_re = re.compile(r"^={5,}(Session\d+/[\w.\-]+)={5,}\s*$")
    st_re = re.compile(r"^={5,}([A-Za-z_ ]+)={5,}\s*$")
    sections, cur = {}, None
    for ln in step:
        m = sec_re.match(ln)
        if m:
            cur = m.group(1)
            sections[cur] = {"status": None, "lines": []}
            continue
        if cur is None:
            continue
        if sections[cur]["status"] is None:
            m2 = st_re.match(ln)
            if m2:
                sections[cur]["status"] = m2.group(1).strip().upper()
                continue
        if ln.startswith("##[error]"):
            cur = None
            continue
        sections[cur]["lines"].append(ln)
    out = {}
    for task, sec in sections.items():
        out[task] = section_result("\n".join(sec["lines"]).strip("\n"), sec["status"])
    tail = "\n".join(step[-80:])
    for task in tasks:
        if task not in out:
            out[task] = {
                "verdict": "JE", "verdict_name": VERDICT_NAMES["JE"], "status": None,
                "passed": None, "total": None, "failed": [], "first_failed": None,
                "hints": collect_hints(tail), "log": tail,
                "note": "В логе грейдера нет секции для этой задачи (итог прогона: %s)" % (conclusion or "?"),
            }
    return out


# ---------------------------------------------------------------------------
# environment checks
# ---------------------------------------------------------------------------

def claude_env(claude_bin):
    """Env for the claude CLI: drop vars of a parent Claude Code session, keep auth/user vars."""
    env = {}
    for k, v in os.environ.items():
        if k == "CLAUDECODE" or k.startswith("CLAUDE_CODE_") or k.startswith("CLAUDE_PREVIEW"):
            continue
        if k in ("CLAUDE_AGENT_SDK_VERSION", "CLAUDE_PID", "CLAUDE_EFFORT"):
            continue
        env[k] = v
    if claude_bin:
        bin_dir = os.path.dirname(claude_bin)
        env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
    return env


def find_claude(explicit=None):
    if explicit:
        return explicit if os.path.exists(explicit) else None
    found = shutil.which("claude")
    if found:
        return found
    home = Path.home()
    for cand in [home / ".claude/local/claude", home / ".local/bin/claude"] + \
            sorted(home.glob(".nvm/versions/node/*/bin/claude"), reverse=True):
        if cand.exists():
            return str(cand)
    return None


class Env:
    def __init__(self, app):
        self.app = app
        self.lock = threading.Lock()
        self.cache = None
        self.cache_at = 0.0
        self.docker_cache = (0.0, None)

    def docker_state(self, max_age=8.0):
        """ok | stopped | hung | permission | missing, plus the server version when ok.

        `docker version` is the cheapest call that needs the daemon. A timeout means the daemon
        exists but does not answer (Docker Desktop stuck or still waking from Resource Saver)."""
        at, val = self.docker_cache
        if val is not None and time.time() - at < max_age:
            return val
        if not shutil.which("docker"):
            val = {"state": "missing"}
        else:
            code, out, err = run_cmd(["docker", "version", "--format", "{{.Server.Version}}"], timeout=12)
            text = (out + err).lower()
            if code == 0 and out.strip():
                val = {"state": "ok", "version": out.strip()}
            elif code == 124:
                val = {"state": "hung"}
            elif "permission denied" in text:
                val = {"state": "permission"}
            else:
                val = {"state": "stopped", "detail": (err or out).strip()[-300:]}
        self.docker_cache = (time.time(), val)
        return val

    def docker_running(self, max_age=8.0):
        return self.docker_state(max_age)["state"] == "ok"

    def check(self, force=False):
        with self.lock:
            if not force and self.cache and time.time() - self.cache_at < 30:
                return self.cache
        app = self.app
        res = {"repo": str(app.repo.root) if app.repo else None, "python": sys.version.split()[0],
               "platform": sys.platform, "version": VERSION}

        def docker():
            st = self.docker_state(0 if force else 8)
            return dict(st, installed=st["state"] != "missing", running=st["state"] == "ok")

        def gh():
            if not shutil.which("gh"):
                return {"installed": False, "authed": False}
            code, _o, _e = run_cmd(["gh", "auth", "status", "--hostname", "github.com"], timeout=15)
            user = app.judge.user() if (code == 0 and app.judge) else None
            return {"installed": True, "authed": code == 0, "user": user}

        def claude():
            path = app.claude_bin
            if not path:
                return {"installed": False, "loggedIn": False}
            code, out, err = run_cmd([path, "auth", "status"], timeout=25, env=claude_env(path))
            info = {"installed": True, "path": path, "loggedIn": False}
            try:
                data = json.loads(out)
                info["loggedIn"] = bool(data.get("loggedIn"))
                info["authMethod"] = data.get("authMethod")
            except ValueError:
                info["error"] = (err or out)[-300:]
            return info

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futs = {k: pool.submit(fn) for k, fn in (("docker", docker), ("gh", gh), ("claude", claude))}
            for k, fut in futs.items():
                try:
                    res[k] = fut.result(timeout=40)
                except Exception as exc:  # pragma: no cover - defensive
                    res[k] = {"error": str(exc)}
        if app.git:
            res["git"] = {"branch": app.git.head_branch(), "remote": app.git.origin_url(), "slug": app.slug}
        res["shellcheck"] = bool(shutil.which("shellcheck"))
        with self.lock:
            self.cache = res
            self.cache_at = time.time()
        return res


# ---------------------------------------------------------------------------
# local test runs
# ---------------------------------------------------------------------------

class LocalRun:
    def __init__(self, key):
        self.id = uuid.uuid4().hex[:12]
        self.key = key
        self.lines = []
        self.cond = threading.Condition()
        self.done = False
        self.started = time.time()
        self.finished = None
        self.exit_code = None
        self.timed_out = False
        self.cancelled = False
        self.proc = None
        self.result = None


class Runner:
    MAX_KEEP = 25

    def __init__(self, app):
        self.app = app
        self.runs = {}
        self.active = {}
        self.lock = threading.Lock()

    def preflight(self, key, tdir, runner):
        """Problems that must be fixed before running (mostly: missing mounted files)."""
        problems = []
        if not runner:
            problems.append({"level": "error", "title": "Нет run_test.sh",
                             "text": "В папке задачи нет скрипта запуска тестов.", "action": None})
            return problems
        for src, _dst in runner.get("mounts") or []:
            src = src.strip("/")
            if not src or src.split("/")[0] in PROTECTED_TOP:
                continue
            p = tdir / src
            base = src.rsplit("/", 1)[-1]
            looks_file = "." in base or base.startswith("Makefile")
            if looks_file and not p.exists():
                problems.append({
                    "level": "error", "title": "Нет файла %s" % src,
                    "text": "Тесты монтируют `%s` в контейнер. Если файла нет, Docker создаст на его месте пустую папку. Сначала создай файл." % src,
                    "action": "create:" + src})
            elif looks_file and p.is_dir():
                problems.append({
                    "level": "error", "title": "%s — папка, а не файл" % src,
                    "text": "Скорее всего, её создал Docker при прошлом запуске, когда файла ещё не было. Удали папку и создай файл `%s`." % src,
                    "action": "rmdir:" + src if not any(p.iterdir()) else None})
        return problems

    def start(self, key):
        app = self.app
        tdir = app.repo.task_dir(key)
        runner = app.repo.runner(tdir)
        with self.lock:
            cur = self.active.get(key)
            if cur and not cur.done:
                return {"id": cur.id, "already": True}
        health = app.repo.health()
        if not health["ok"]:
            return {"blocked": True, "problems": [{
                "level": "error", "title": "Файлы репозитория недоступны",
                "text": "Не получается прочитать файлы репозитория, так что тесты их тоже не прочитают. Подожди немного и повтори.",
                "action": None}]}
        problems = self.preflight(key, tdir, runner)
        if problems:
            return {"blocked": True, "problems": problems}
        if runner.get("docker"):
            st = app.env.docker_state(0)["state"]
            if st != "ok":
                return {"offline": True, "result": docker_offline_result(st)}
        run = LocalRun(key)
        run.runner = runner
        with self.lock:
            self.runs[run.id] = run
            self.active[key] = run
            if len(self.runs) > 60:
                for rid in sorted(self.runs, key=lambda r: self.runs[r].started)[:20]:
                    if self.runs[rid].done:
                        self.runs.pop(rid, None)
        threading.Thread(target=self._work, args=(run, tdir, runner), daemon=True).start()
        log("[run]", key, "started", run.id)
        return {"id": run.id}

    def _emit(self, run, text):
        with run.cond:
            for line in text.split("\n"):
                run.lines.append(line[:4000])
            run.cond.notify_all()

    def _work(self, run, tdir, runner):
        """Thread body. Whatever happens, the run ends up done (otherwise the task stays
        "already running" forever and its stream pings endlessly)."""
        try:
            self._work_inner(run, tdir, runner)
        except Exception as exc:
            traceback.print_exc()
            self._emit(run, "[SegForces] внутренняя ошибка: %s" % exc)
            if run.proc and run.proc.poll() is None:
                kill_tree(run.proc)
            if not run.done:
                self._finish(run, -1)

    def _work_inner(self, run, tdir, runner):
        env = dict(os.environ)
        env.pop("HIDDEN_TESTS_ENABLED", None)
        env["DOCKER_CLI_HINTS"] = "false"
        env["BUILDKIT_PROGRESS"] = "plain"
        env["PYTHONUNBUFFERED"] = "1"
        timeout = self.app.args.run_timeout
        try:
            run.proc = subprocess.Popen(
                ["bash", runner["script"]], cwd=str(tdir), env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        except OSError as exc:
            self._emit(run, "Не удалось запустить тесты: %s" % exc)
            self._finish(run, 127)
            return

        def watchdog():
            deadline = run.started + timeout
            while run.proc.poll() is None:
                if time.time() > deadline:
                    run.timed_out = True
                    self._emit(run, "\n[SegForces] Превышен лимит %d с — процесс остановлен." % timeout)
                    kill_tree(run.proc)
                    kill_test_containers(runner)
                    break
                time.sleep(0.5)
        threading.Thread(target=watchdog, daemon=True).start()
        buf = b""
        while True:
            chunk = run.proc.stdout.read1(65536) if hasattr(run.proc.stdout, "read1") else run.proc.stdout.read(4096)
            if not chunk:
                break
            buf += chunk
            if b"\n" in buf:
                head, buf = buf.rsplit(b"\n", 1)
                self._emit(run, _dec(head).replace("\r", ""))
        if buf:
            self._emit(run, _dec(buf).replace("\r", ""))
        code = run.proc.wait()
        self._finish(run, code, tdir, runner)

    def build_probe(self, run, tdir, runner):
        """Python-driven C tests hide compiler output (capture_output=True).
        When such a run fails, rebuild a copy of the solution in the same image to surface it."""
        mounts = [(s.strip("/"), d) for s, d in runner.get("mounts") or []]
        if not runner.get("image") or not any(s == "Makefile.Student" for s, _ in mounts):
            return None
        if not (tdir / "Makefile.Student").is_file():
            return None
        targets = self.app.repo.make_targets(tdir)
        if not targets:
            return None
        tmp = Path(tempfile.mkdtemp(prefix="segforces-build-"))
        try:
            args = ["docker", "run", "--rm", "--network", "none", "--entrypoint", "/bin/bash"]
            for src, dst in mounts:
                if src.split("/")[0] in PROTECTED_TOP:
                    continue
                sp, cp = tdir / src, tmp / src
                if sp.is_dir():
                    copy_tree_plain(sp, cp)
                elif sp.is_file():
                    cp.parent.mkdir(parents=True, exist_ok=True)
                    cp.write_bytes(read_bytes(sp))
                else:
                    continue
                args += ["-v", "%s:%s" % (cp, dst)]
            cmd = " && ".join("make -f Makefile.Student %s" % t for t in targets)
            self._emit(run, "\n[SegForces] Тесты упали — проверяю сборку той же командой, что и тесты: %s" % cmd)
            code, out, err = run_cmd(args + [runner["image"], "-c", "cd /task && " + cmd], timeout=180)
            text = (out + ("\n" + err if err else "")).strip()
            if text:
                self._emit(run, text)
            self._emit(run, "[SegForces] сборка: %s" % ("OK" if code == 0 else "ошибка (код %s)" % code))
            return {"code": code, "log": text, "cmd": cmd}
        except OSError as exc:
            self._emit(run, "[SegForces] не удалось проверить сборку: %s" % exc)
            return None
        finally:
            shutil.rmtree(str(tmp), ignore_errors=True)

    def _finish(self, run, code, tdir=None, runner=None):
        if run.done:
            return
        run.exit_code = code
        res = None
        try:
            res = self._verdict(run, code, tdir, runner)
        except Exception as exc:
            traceback.print_exc()
            res = {"verdict": "JE", "verdict_name": VERDICT_NAMES["JE"], "passed": None, "total": None,
                   "first_failed": None, "failed": [], "hints": [], "note": "Внутренняя ошибка SegForces: %s" % exc}
        finally:
            if res is None:
                res = {"verdict": "JE", "verdict_name": VERDICT_NAMES["JE"], "passed": None, "total": None,
                       "first_failed": None, "failed": [], "hints": [], "note": "Прогон прерван"}
            run.finished = time.time()
            res.update({"id": run.id, "key": run.key, "at": run.started, "duration": run.finished - run.started,
                        "exit_code": code})
            run.result = res
            try:
                stored = dict(res)
                stored["output"] = "\n".join(run.lines)[-150000:]
                self.app.state_add_run(run.key, stored)
            except Exception:
                traceback.print_exc()
            with run.cond:
                run.done = True
                run.cond.notify_all()
        log("[run]", run.key, "->", res["verdict"], "%.1fs" % res["duration"])

    def _verdict(self, run, code, tdir, runner):
        output = "\n".join(run.lines)
        res = analyze(output, code, run.timed_out, run.cancelled)
        missing_bin = bool(re.search(r"No such file or directory|not found", output))
        if (tdir is not None and runner and not run.cancelled and not run.timed_out
                and (res["verdict"] in ("RE", "JE") or (res["verdict"] == "WA" and missing_bin))):
            probe = self.build_probe(run, tdir, runner)
            if probe and probe["code"] not in (0, 124):
                log_text = probe["log"]
                errs = GCC_ERR.findall(log_text)
                res["verdict"] = "CE"
                res["verdict_name"] = VERDICT_NAMES["CE"]
                res["compile_errors"] = (["%s:%s: %s" % (f, ln, msg) for f, ln, _c, msg in errs[:25]]
                                         or log_text.splitlines()[-25:])
                merged, seen = [], set()
                for h in collect_hints(log_text) + res["hints"]:
                    if h["title"] in seen or h["title"] == "Файл не найден":
                        continue
                    seen.add(h["title"])
                    merged.append(h)
                res["hints"] = merged
                res["first_failed"] = None
                res["failed"] = []
                res["build"] = {"cmd": probe["cmd"], "ok": False}
                res["note"] = "Решение не собирается — тестам нечего запускать"
            elif probe and probe["code"] == 0:
                res["build"] = {"cmd": probe["cmd"], "ok": True}
                if any(h["title"] == "Файл не найден" for h in res["hints"]):
                    res["hints"].append({
                        "level": "info", "title": "Сборка проходит",
                        "text": "`%s` отрабатывает без ошибок, но тест не нашёл нужный файл. Проверь имя и место результата сборки: что именно и куда кладёт твой Makefile." % probe["cmd"],
                        "action": None})
        return res

    def cancel(self, run_id):
        run = self.runs.get(run_id)
        if not run or run.done:
            return False
        run.cancelled = True
        if run.proc:
            kill_tree(run.proc)
        threading.Thread(target=kill_test_containers, args=(getattr(run, "runner", None),), daemon=True).start()
        return True


def kill_test_containers(runner):
    """Killing the docker CLI does not stop its container (run_test.sh uses an unnamed
    `docker run --rm`), so stop containers started from the task's test image."""
    image = (runner or {}).get("image")
    if not image or not (runner or {}).get("docker") or not shutil.which("docker"):
        return
    code, out, _e = run_cmd(["docker", "ps", "-q", "--filter", "ancestor=%s" % image], timeout=15)
    ids = out.split() if code == 0 else []
    if ids:
        run_cmd(["docker", "kill"] + ids, timeout=30)
        log("[run] остановлены контейнеры", image, len(ids))


# ---------------------------------------------------------------------------
# console: run an arbitrary command against a throwaway copy of the task
# ---------------------------------------------------------------------------

def copy_tree_plain(src, dst, skip_dirs=()):
    """Like shutil.copytree, but copies file contents with plain read()/write().

    On macOS shutil (and cp) use fcopyfile(), which fails with "Operation timed out"
    on evicted (cloud-synced, "dataless") files, while an ordinary read() fetches them fine.
    """
    src, dst = Path(src), Path(dst)
    for root, dirs, names in os.walk(str(src)):
        rel = os.path.relpath(root, str(src))
        target_root = dst if rel == "." else dst / rel
        target_root.mkdir(parents=True, exist_ok=True)
        keep = []
        for d in dirs:
            p = Path(root) / d
            if d in skip_dirs:
                continue
            if p.is_symlink():
                os.symlink(os.readlink(str(p)), str(target_root / d))
                continue
            keep.append(d)
        dirs[:] = keep
        for n in names:
            sp, tp = Path(root) / n, target_root / n
            if sp.is_symlink():
                os.symlink(os.readlink(str(sp)), str(tp))
                continue
            try:
                st = sp.stat()
                if not stat.S_ISREG(st.st_mode):
                    continue
                data = read_bytes(sp)
            except OSError:
                continue
            with open(str(tp), "wb") as fh:
                fh.write(data)
            os.chmod(str(tp), stat.S_IMODE(st.st_mode))
            os.utime(str(tp), (st.st_atime, st.st_mtime))


def snapshot_tree(root):
    snap = {}
    for dirpath, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in (".hidden_tests", "__pycache__")]
        for n in names:
            p = os.path.join(dirpath, n)
            try:
                st = os.lstat(p)
            except OSError:
                continue
            snap[os.path.relpath(p, root)] = (st.st_size, st.st_mtime_ns, stat.S_ISLNK(st.st_mode))
    return snap


class Console:
    def __init__(self, app):
        self.app = app

    def image_for(self, runner):
        img = (runner or {}).get("image")
        if img:
            code, _o, _e = run_cmd(["docker", "image", "inspect", img], timeout=10)
            if code == 0:
                return img, True
        return "debian:stable-slim", False

    def execute(self, key, cmd, stdin_text, mode, timeout):
        app = self.app
        tdir = app.repo.task_dir(key)
        runner = app.repo.runner(tdir)
        cmd = (cmd or "").strip()
        if not cmd:
            raise ApiError(400, "Пустая команда")
        tmp = Path(tempfile.mkdtemp(prefix="segforces-"))
        work = tmp / "task"
        try:
            copy_tree_plain(tdir, work, skip_dirs=(".hidden_tests", "__pycache__", ".git"))
            before = snapshot_tree(str(work))
            started = time.time()
            image, from_tests = None, False
            if mode == "docker":
                st = app.env.docker_state(0)["state"]
                if st != "ok":
                    p = docker_problem(st)
                    raise ApiError(409, "%s. Можно переключиться на запуск локально." % p["title"], action=p["action"])
                image, from_tests = self.image_for(runner)
                name = "segforces-%s" % uuid.uuid4().hex[:10]
                args = ["docker", "run", "--rm", "-i", "--name", name, "--network", "none",
                        "--memory", "1g", "--pids-limit", "512", "-v", "%s:/task" % work, "-w", "/task",
                        "--entrypoint", "/bin/bash", image, "-c", cmd]
                code, out, err = run_cmd(args, timeout=timeout + (60 if not from_tests else 5),
                                         input_text=stdin_text or "")
                if code == 124:
                    run_cmd(["docker", "kill", name], timeout=10)
            else:
                env = dict(os.environ)
                env.pop("HIDDEN_TESTS_ENABLED", None)
                code, out, err = run_cmd(["/bin/bash", "-c", cmd], cwd=str(work), timeout=timeout,
                                         env=env, input_text=stdin_text or "")
            duration = time.time() - started
            after = snapshot_tree(str(work))
            changes = []
            for rel, meta in sorted(after.items()):
                old = before.get(rel)
                if old == meta:
                    continue
                item = {"path": rel, "change": "new" if old is None else "modified"}
                full = work / rel
                if not meta[2] and meta[0] <= 64 * 1024:
                    try:
                        data = read_bytes(full)
                        if b"\0" not in data:
                            item["preview"] = _dec(data[:4000])
                    except OSError:
                        pass
                elif meta[2]:
                    try:
                        item["link"] = os.readlink(str(full))
                    except OSError:
                        pass
                changes.append(item)
            for rel in sorted(set(before) - set(after)):
                changes.append({"path": rel, "change": "deleted"})
            return {
                "cmd": cmd, "mode": mode, "image": image, "code": code, "timed_out": code == 124,
                "stdout": out[-200000:], "stderr": err[-100000:], "duration": duration,
                "changes": changes[:200],
            }
        finally:
            shutil.rmtree(str(tmp), ignore_errors=True)


# ---------------------------------------------------------------------------
# git: per-task submit
# ---------------------------------------------------------------------------

def slug_from_url(url):
    m = re.search(r"github\.com[:/]+([^/\s]+/[^/\s]+?)(?:\.git)?/?$", url or "")
    return m.group(1) if m else None


def parse_porcelain_z(out):
    items = out.split("\0")
    res, i = [], 0
    while i < len(items):
        it = items[i]
        i += 1
        if len(it) < 4:
            continue
        xy, path = it[:2], it[3:]
        if "R" in xy or "C" in xy:
            i += 1
        res.append((xy, path))
    return res


STATUS_LABELS = {"M": "изменён", "A": "новый", "D": "удалён", "R": "переименован", "?": "новый", "T": "изменён"}


class Git:
    def __init__(self, root):
        self.root = Path(root)
        self.lock = threading.Lock()

    def env(self):
        e = dict(os.environ)
        # GIT_LITERAL_PATHSPECS: a path like "task/*" must never be expanded by git into other files
        e.update({"GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C",
                  "GIT_PAGER": "cat", "GCM_INTERACTIVE": "never", "GIT_LITERAL_PATHSPECS": "1"})
        return e

    def run(self, args, timeout=60, input_text=None):
        return run_cmd(["git", "-C", str(self.root)] + list(args), timeout=timeout, env=self.env(),
                       input_text=input_text)

    def head_branch(self):
        try:
            s = read_text(self.root / ".git" / "HEAD").strip()
        except OSError:
            return None
        return s[len("ref: refs/heads/"):] if s.startswith("ref: refs/heads/") else None

    def origin_url(self):
        try:
            cfg = read_text(self.root / ".git" / "config")
        except OSError:
            return None
        m = re.search(r'\[remote "origin"\][^\[]*?url\s*=\s*(\S+)', cfg, re.S)
        return m.group(1) if m else None

    @staticmethod
    def timeout_hint(code):
        if code == 124:
            return ("git не ответил вовремя: файлы репозитория читаются очень медленно. Подожди немного и повтори.")
        return None

    def task_changes(self, key):
        """Changed/new/deleted files under the task dir, straight from `git status`."""
        code, out, err = self.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", key + "/"],
                                  timeout=240)
        if code != 0:
            raise ApiError(500, "git status не отработал: %s" % (err or out)[-400:], hint=self.timeout_hint(code))
        files = []
        for xy, path in parse_porcelain_z(out):
            if not path.startswith(key + "/"):
                continue
            rel = path[len(key) + 1:]
            full = self.root / path
            deleted = "D" in xy
            binary = (not deleted) and full.is_file() and is_binary(full)
            artifact = binary or bool(ARTIFACT_RE.search(rel))
            protected = is_protected_rel(rel)
            label_key = xy.strip()[:1] or "?"
            files.append({
                "path": path, "rel": rel, "xy": xy, "status": STATUS_LABELS.get(label_key, xy.strip()),
                "binary": binary, "artifact": artifact, "protected": protected,
                "selected": not (artifact or protected),
                "exec": (not deleted) and full.is_file() and bool(full.stat().st_mode & 0o111),
            })
        return files

    def lock_path(self):
        return self.root / ".git" / "index.lock"

    def lock_state(self):
        """index.lock left behind by a git that was killed (e.g. after a timeout) blocks every
        later add/commit. It is stale when nobody holds it open and it is not brand new."""
        p = self.lock_path()
        try:
            age = time.time() - p.stat().st_mtime
        except OSError:
            return None
        code, out, _e = run_cmd(["lsof", "-t", str(p)], timeout=10)
        held = bool(out.strip())
        known = code in (0, 1)  # lsof: 0 = someone has it open, 1 = nobody
        return {"age": int(age), "held": held, "stale": not held and age > (30 if known else 120)}

    def lock_error(self, text):
        if "index.lock" not in (text or ""):
            return None
        st = self.lock_state()
        if st and st["stale"]:
            return ApiError(409, "Git заблокирован старым index.lock — его оставил прерванный git-процесс.",
                            stale_lock=True, hint="Нажми «Убрать зависшую блокировку» и отправь снова.")
        return ApiError(409, "Git сейчас занят другим процессом (index.lock). Подожди немного и повтори.",
                        hint="Если в терминале идёт git commit/rebase — заверши его.")

    def preflight(self, key):
        branch = self.head_branch()
        errors, warnings = [], []
        if branch != "master":
            errors.append("Сейчас ветка «%s». Грейдер реагирует только на push в master." % branch)
        lock = self.lock_state()
        if lock:
            errors.append("Git заблокирован (.git/index.lock)%s." % (
                " — похоже, его оставил прерванный git-процесс" if lock["stale"] else ": сейчас работает другой git-процесс"))
        files = self.task_changes(key)
        code, staged, _e = self.run(["diff", "--cached", "--name-only", "-z"], timeout=120)
        staged_other = [p for p in staged.split("\0") if p and not p.startswith(key + "/")]
        fcode, _fo, ferr = self.run(["fetch", "--quiet", "origin"], timeout=30)
        ahead = behind = 0
        unpushed = []
        code, ab, _e = self.run(["rev-list", "--left-right", "--count", "HEAD...origin/master"], timeout=60)
        if code == 0 and ab.strip():
            try:
                ahead, behind = [int(x) for x in ab.split()[:2]]
            except ValueError:
                pass
        if ahead:
            code, lg, _e = self.run(["log", "--format=%h %s", "origin/master..HEAD"], timeout=60)
            unpushed = [ln for ln in lg.splitlines() if ln.strip()][:20]
        if behind:
            errors.append("На GitHub есть %d коммит(ов), которых нет локально. Сначала подтяни их: `git pull --rebase`." % behind)
        if ahead:
            warnings.append("Есть %d неотправленных коммит(ов) — они уйдут вместе с этим. Грейдер проверит только последний коммит." % ahead)
        if staged_other:
            warnings.append("В индексе есть изменения вне этой задачи (%d) — в коммит они НЕ попадут и останутся как есть." % len(staged_other))
        if fcode != 0:
            warnings.append("Не получилось сделать git fetch (нет сети?) — проверка «не отстаёт ли ветка» пропущена.")
        sh_missing_exec = [f["rel"] for f in files if f["rel"].endswith(".sh") and f["selected"] and not f["exec"] and "D" not in f["xy"]]
        if sh_missing_exec:
            warnings.append("Без бита исполнения: %s — тесты не смогут запустить скрипт. Сделай chmod +x." % ", ".join(sh_missing_exec))
        return {
            "key": key, "branch": branch, "files": files, "message": "GRADER\n%s" % key,
            "errors": errors, "warnings": warnings, "ahead": ahead, "behind": behind, "lock": lock,
            "unpushed": unpushed, "staged_other": staged_other[:20], "remote": self.origin_url(),
        }

    def submit(self, key, paths, allow_empty, emit):
        if not self.lock.acquire(blocking=False):
            raise ApiError(409, "Уже идёт другая отправка")
        try:
            if self.head_branch() != "master":
                raise ApiError(409, "Отправлять можно только из ветки master")
            # Only paths that a fresh `git status` reports as changed inside this task and that
            # are not part of the statement/tests may be committed — whatever the client sends.
            allowed = {f["path"] for f in self.task_changes(key) if not f["protected"]}
            clean = []
            for p in paths or []:
                if not isinstance(p, str) or p not in allowed:
                    raise ApiError(400, "Файл %r не входит в изменения задачи %s — отправка отменена" % (p, key))
                if p not in clean:
                    clean.append(p)
            message = "GRADER\n%s\n" % key
            if clean:
                emit({"type": "step", "text": "git add (%d файл.)" % len(clean)})
                code, out, err = self.run(["add", "-A", "--"] + clean, timeout=240)
                if code != 0:
                    raise self.lock_error(err + out) or ApiError(500, "git add: %s" % (err or out)[-600:], hint=self.timeout_hint(code))
                emit({"type": "step", "text": "git commit — только выбранные файлы"})
                # hooks off + verbatim cleanup: the message stays exactly "GRADER\n<task>", nothing appended
                code, out, err = self.run(["-c", "core.hooksPath=/dev/null", "commit", "--cleanup=verbatim",
                                           "-F", "-", "--"] + clean, timeout=240, input_text=message)
                if code != 0:
                    if "nothing" in (out + err) and allow_empty:
                        clean = []
                    else:
                        raise self.lock_error(err + out) or ApiError(500, "git commit: %s" % (err or out)[-600:], hint=self.timeout_hint(code))
                else:
                    emit({"type": "log", "text": out.strip()})
            if not clean:
                if not allow_empty:
                    raise ApiError(400, "Нечего отправлять: в задаче нет изменений")
                emit({"type": "step", "text": "Пустой коммит для повторной проверки"})
                code, head, err = self.run(["rev-parse", "--verify", "HEAD"], timeout=60)
                head = head.strip()
                if code != 0 or not head:
                    raise ApiError(500, "git rev-parse: %s" % err[-400:])
                code, tree, err = self.run(["rev-parse", head + "^{tree}"], timeout=60)
                if code != 0:
                    raise ApiError(500, "git rev-parse: %s" % err[-400:])
                code, sha, err = self.run(["commit-tree", tree.strip(), "-p", head, "-F", "-"], timeout=60,
                                          input_text=message)
                if code != 0:
                    raise ApiError(500, "git commit-tree: %s" % err[-400:])
                # old value guards against a commit made in a terminal meanwhile
                code, _o, err = self.run(["update-ref", "-m", "segforces: resubmit %s" % key, "HEAD",
                                          sha.strip(), head], timeout=60)
                if code != 0:
                    raise ApiError(500, "git update-ref: %s" % err[-400:])
            return self.push(emit)
        finally:
            self.lock.release()

    def push(self, emit):
        emit({"type": "step", "text": "git push origin master"})
        code, out, err = self.run(["push", "origin", "master"], timeout=240)
        text = (out + "\n" + err).strip()
        if text:
            emit({"type": "log", "text": text})
        if code != 0:
            hint = self.timeout_hint(code)
            if "rejected" in text or "fetch first" in text or "non-fast-forward" in text:
                hint = "На GitHub есть коммиты, которых нет у тебя. Сделай `git pull --rebase` и отправь снова (коммит уже создан локально)."
            elif "Authentication failed" in text or "could not read Username" in text or "403" in text:
                hint = "Git не смог авторизоваться на GitHub. Выполни в терминале `gh auth setup-git` и повтори."
            raise ApiError(500, "git push не прошёл", hint=hint, log=text[-2000:], committed=True)
        code, sha, _e = self.run(["rev-parse", "HEAD"], timeout=60)
        return sha.strip()


# ---------------------------------------------------------------------------
# judge: GitHub Actions grader results via the gh CLI
# ---------------------------------------------------------------------------

class Judge:
    def __init__(self, app):
        self.app = app
        self.store = JsonStore(app.data_dir / "judge.json", {"runs": {}, "commits": {}, "user": None})
        self.lock = threading.Lock()
        self.last_sync = 0.0
        self.last_error = None
        self._reparse()

    def _reparse(self):
        """Re-run the analyzer on stored per-task logs when the parser got smarter."""
        if self.store.data.get("parser") == PARSER_VERSION:
            return
        for run in self.store.data["runs"].values():
            for task, res in list((run.get("results") or {}).items()):
                if res.get("status") and res.get("log") is not None:
                    run["results"][task] = section_result(res["log"], res["status"])
        self.store.data["parser"] = PARSER_VERSION
        self.store.save()

    @property
    def slug(self):
        return self.app.slug

    def gh(self, args, timeout=40):
        return run_cmd(["gh"] + list(args), timeout=timeout)

    def available(self):
        return bool(self.slug) and bool(shutil.which("gh"))

    def user(self):
        if self.store.data.get("user"):
            return self.store.data["user"]
        code, out, _e = self.gh(["api", "user", "-q", ".login"], timeout=15)
        if code == 0 and out.strip():
            with self.store.lock:
                self.store.data["user"] = out.strip()
                self.store.save()
            return out.strip()
        return None

    def commit_message(self, sha):
        msgs = self.store.data["commits"]
        with self.store.lock:
            if sha in msgs:
                return msgs[sha]
        code, out, _e = self.gh(["api", "repos/%s/commits/%s" % (self.slug, sha), "-q", ".commit.message"])
        if code != 0:
            return None
        with self.store.lock:
            msgs[sha] = out.rstrip("\n")
            return msgs[sha]

    def runs_snapshot(self):
        with self.store.lock:
            return list(self.store.data["runs"].values())

    @staticmethod
    def tasks_from_message(msg):
        lines = (msg or "").splitlines()
        if not lines or lines[0].strip() != "GRADER":
            return []
        return [t for t in " ".join(lines[1:]).split() if TASK_KEY_RE.match(t)]

    def fetch_log(self, run_id):
        code, out, _e = self.gh(["api", "repos/%s/actions/runs/%s/jobs" % (self.slug, run_id), "-q", ".jobs[0].id"])
        if code != 0 or not out.strip():
            return None
        job = out.strip()
        code, out, _e = self.gh(["api", "repos/%s/actions/jobs/%s/logs" % (self.slug, job)], timeout=60)
        return out if code == 0 else None

    def _process(self, r):
        rid = str(r["databaseId"])
        cached = self.store.data["runs"].get(rid)
        if cached and cached.get("status") == "completed" and (cached.get("parsed") or not cached.get("grader")):
            return
        entry = {
            "id": rid, "sha": r.get("headSha"), "status": r.get("status"), "conclusion": r.get("conclusion"),
            "created": r.get("createdAt"), "updated": r.get("updatedAt"), "url": r.get("url"),
            "title": r.get("displayTitle"), "grader": (r.get("displayTitle") or "").strip() == "GRADER",
        }
        if entry["grader"]:
            msg = self.commit_message(entry["sha"])
            entry["tasks"] = self.tasks_from_message(msg) if msg else (cached or {}).get("tasks", [])
            if entry["status"] == "completed":
                raw = self.fetch_log(rid)
                if raw is not None:
                    entry["results"] = parse_grader_log(raw, entry["tasks"], entry["conclusion"])
                    entry["parsed"] = True
        with self.store.lock:
            self.store.data["runs"][rid] = entry

    def sync(self, force=False, limit=60):
        if not self.available():
            self.last_error = "gh не установлен или не найден GitHub-репозиторий"
            return False
        with self.lock:
            if not force and time.time() - self.last_sync < 15:
                return True
            code, out, err = self.gh(["run", "list", "-R", self.slug, "--limit", str(limit), "--json",
                                      "databaseId,headSha,status,conclusion,createdAt,updatedAt,url,displayTitle"])
            if code != 0:
                self.last_error = (err or out).strip()[-400:]
                return False
            try:
                runs = json.loads(out)
            except ValueError:
                self.last_error = "Непонятный ответ gh"
                return False
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(self._safe_process, runs))
            self.store.save()
            self.last_sync = time.time()
            self.last_error = None
            return True

    def _safe_process(self, r):
        try:
            self._process(r)
        except Exception:  # keep syncing other runs
            traceback.print_exc()

    def poll_commit(self, sha):
        """Status of the grader run for one commit (used right after a submit)."""
        if not self.available():
            return {"state": "unknown"}
        for entry in self.runs_snapshot():
            if entry.get("sha") == sha and entry.get("status") == "completed" and entry.get("parsed"):
                return {"state": "completed", "run": entry}
        code, out, _e = self.gh(["run", "list", "-R", self.slug, "--commit", sha, "--limit", "5", "--json",
                                 "databaseId,headSha,status,conclusion,createdAt,updatedAt,url,displayTitle"])
        if code != 0:
            return {"state": "unknown", "error": _e[-300:]}
        try:
            runs = json.loads(out)
        except ValueError:
            runs = []
        if not runs:
            return {"state": "waiting"}
        for r in runs:
            self._safe_process(r)
        with self.store.lock:
            self.store.save()
            entry = self.store.data["runs"].get(str(runs[0]["databaseId"]))
        state = "completed" if entry and entry.get("status") == "completed" else (entry or {}).get("status", "queued")
        return {"state": state, "run": entry}

    def runs_sorted(self):
        runs = [r for r in self.runs_snapshot() if r.get("grader")]
        runs.sort(key=lambda r: r.get("created") or "")
        return runs

    def history(self, key=None):
        items = []
        for r in self.runs_sorted():
            for task in r.get("tasks") or []:
                if key and task != key:
                    continue
                res = (r.get("results") or {}).get(task)
                if r.get("status") == "completed":
                    verdict = res["verdict"] if res else ("AC" if r.get("conclusion") == "success" else "JE")
                else:
                    verdict = "TESTING" if r.get("status") == "in_progress" else "QUEUED"
                items.append({
                    "key": task, "run_id": r["id"], "sha": r.get("sha"), "created": r.get("created"),
                    "url": r.get("url"), "status": r.get("status"), "verdict": verdict,
                    "verdict_name": VERDICT_NAMES.get(verdict, verdict),
                    "passed": res.get("passed") if res else None, "total": res.get("total") if res else None,
                    "first_failed": res.get("first_failed") if res else None,
                    "multi": len(r.get("tasks") or []) > 1,
                })
        return items

    def summary_by_task(self):
        out = {}
        for item in self.history():
            s = out.setdefault(item["key"], {"count": 0, "solved": False, "last": None, "solved_at": None})
            s["count"] += 1
            s["last"] = item
            if item["verdict"] == "AC" and not s["solved"]:
                s["solved"] = True
                s["solved_at"] = item["created"]
        return out

    def run_detail(self, run_id, task=None):
        r = self.store.data["runs"].get(str(run_id))
        if not r:
            raise ApiError(404, "Прогон не найден")
        res = dict(r)
        if task and r.get("results"):
            res["result"] = r["results"].get(task)
        return res


# ---------------------------------------------------------------------------
# Claude helper (claude CLI in headless mode)
# ---------------------------------------------------------------------------

SYSTEM_PROMPT_BASE = """Ты — Claude, наставник в SegForces: локальной системе в стиле Codeforces/LeetCode для курса «Основы программирования на C и Linux». Студент решает задачи на bash и C.

Правила:
- Отвечай по-русски, по делу, без воды. Используй markdown; код — в блоках ```bash / ```c / ```makefile.
- Файлы задачи можно читать (Read/Grep/Glob), изменять и запускать — нет: правки вносит сам студент в редакторе.
- Тесты гоняются в Docker (Debian: bash 5, GNU coreutils/findutils/grep/sed, gcc, make, python3), а не на macOS студента. Учитывай разницу BSD/GNU и bash 3.2/5.
- Открытые тесты лежат в open_tests/. Скрытые недоступны — не выдумывай их содержимое, но можешь предполагать, какие граничные случаи там вероятны.
- Если видишь вывод упавших тестов — объясни причину простыми словами и укажи место в коде (файл и строку).
- Студент сдаёт решение кнопкой «Отправить» (коммит GRADER в master). Не предлагай коммитить что-то кроме файлов решения."""

SYSTEM_PROMPT_MODES = {
    "hint": """РЕЖИМ: ПОДСКАЗКИ.
Не пиши готовое решение задачи целиком и не переписывай код студента полностью. Давай наводящие подсказки, задавай вопросы, указывай, где ошибка и почему, объясняй нужные концепции и команды. Короткие фрагменты (до ~5 строк), иллюстрирующие идею, — можно. Если студент прямо просит полное решение — напомни, что можно переключить режим на «Полный разбор» в шапке чата.""",
    "full": """РЕЖИМ: ПОЛНЫЙ РАЗБОР.
Можно дать полное решение, но объясни каждую часть, чтобы студент понял, а не просто скопировал. Укажи, какие граничные случаи учтены.""",
}

MODEL_CHOICES = {"", "sonnet", "opus", "haiku", "fable"}


class Helper:
    def __init__(self, app):
        self.app = app
        self.dir = app.data_dir / "chats"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.active = {}
        self.lock = threading.Lock()

    def path(self, key):
        return self.dir / (key.replace("/", "__") + ".json")

    def load(self, key):
        try:
            data = load_json_file(self.path(key))
        except OSError as exc:
            raise ApiError(503, "Не удалось прочитать историю чата: %s" % exc)
        if isinstance(data, dict):
            data.setdefault("messages", [])
            data.setdefault("ctx", {})
            return data
        return {"session_id": None, "messages": [], "ctx": {}}

    def save(self, key, chat):
        p = self.path(key)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(chat, ensure_ascii=False), "utf-8")
        os.replace(str(tmp), str(p))

    def reset(self, key):
        try:
            self.path(key).unlink()
        except OSError:
            pass

    def code_snapshot(self, key, detail):
        tdir = Path(detail["dir"])
        parts, total = [], 0
        for f in detail["files"]:
            if f["binary"] or f["artifact"] or f["size"] > 200 * 1024:
                continue
            try:
                text = read_text(tdir / f["path"])
            except OSError:
                continue
            total += len(text)
            if total > 120000:
                parts.append("_(остальные файлы не влезли — прочитай их сам через Read)_")
                break
            lang = {"shell": "bash", "makefile": "makefile", "c": "c", "cpp": "cpp", "python": "python"}.get(f["lang"], "")
            mode = " (исполняемый)" if f["exec"] else ""
            parts.append("### %s%s\n```%s\n%s\n```" % (f["path"], mode, lang, text.rstrip("\n")))
        missing = [e["path"] for e in detail["expected"] if not e["exists"]]
        if missing:
            parts.append("Ещё не созданы: %s" % ", ".join(missing))
        return "\n\n".join(parts) if parts else "_(файлов решения пока нет)_"

    def build_prompt(self, key, chat, payload):
        app = self.app
        detail = app.repo.task_detail(key)
        text = (payload.get("text") or "").strip()
        mode = payload.get("mode") if payload.get("mode") in SYSTEM_PROMPT_MODES else "hint"
        parts = []
        ctx = chat.setdefault("ctx", {})
        if not chat.get("session_id") or payload.get("full_context"):
            parts.append("# Задача %s — %s\nБаллы: %s · дедлайн: %s" % (
                key, detail["title"], detail.get("points") or "?", detail.get("deadline") or "?"))
            parts.append("## Условие (%s)\n%s" % (detail.get("readme") or "ReadMe.md", detail["statement"].strip()))
            tests = ", ".join(t["path"] for t in detail["tests"]) or "нет"
            parts.append("## Как проверяется\nОткрытые тесты: %s (можешь прочитать). Запуск тестов: `%s`." % (
                tests, (detail.get("runner") or {}).get("script", "run_test.sh")))
        if payload.get("include_code", True):
            snap = self.code_snapshot(key, detail)
            h = sha1(snap)
            if h != ctx.get("code_hash") or payload.get("full_context"):
                parts.append("## Мой текущий код\n" + snap)
                ctx["code_hash"] = h
            else:
                parts.append("_(Код не менялся с прошлого сообщения.)_")
        if payload.get("include_run", True):
            last = app.state_last_run(key)
            if last and (last.get("id") != ctx.get("run_id") or payload.get("full_context")):
                out = tail_lines(last.get("output") or "", 160)
                parts.append("## Последний локальный прогон открытых тестов: %s%s\n```\n%s\n```" % (
                    last.get("verdict_name") or last.get("verdict"),
                    " (%s/%s)" % (last.get("passed"), last.get("total")) if last.get("total") else "",
                    out[-20000:]))
                ctx["run_id"] = last.get("id")
            judge = app.judge.history(key)
            if judge:
                j = judge[-1]
                jid = "%s:%s" % (j["run_id"], j["verdict"])
                if j["verdict"] not in ("AC", "TESTING", "QUEUED") and jid != ctx.get("judge_id"):
                    run = app.judge.store.data["runs"].get(j["run_id"], {})
                    res = (run.get("results") or {}).get(key) or {}
                    if res.get("log"):
                        parts.append("## Последняя проверка грейдером (скрытые тесты): %s\n```\n%s\n```" % (
                            j["verdict_name"], tail_lines(res["log"], 120)[-15000:]))
                        ctx["judge_id"] = jid
        if payload.get("selection"):
            parts.append("## Выделенный фрагмент (%s)\n```\n%s\n```" % (
                payload.get("selection_file") or "", payload["selection"][:8000]))
        parts.append("## Режим: %s\n\n## Вопрос\n%s" % (
            "подсказки (без готового решения)" if mode == "hint" else "полный разбор", text))
        return "\n\n".join(parts), mode

    def stop(self, key):
        with self.lock:
            proc = self.active.get(key)
        if proc and proc.poll() is None:
            kill_tree(proc)
            return True
        return False

    def ask(self, key, payload, emit):
        app = self.app
        if not app.claude_bin:
            raise ApiError(503, "claude CLI не найден", code="no_cli")
        text = (payload.get("text") or "").strip()
        if not text:
            raise ApiError(400, "Пустой вопрос")
        tdir = app.repo.task_dir(key)
        chat = self.load(key)
        if payload.get("new"):
            chat = {"session_id": None, "messages": [], "ctx": {}}
        prompt, mode = self.build_prompt(key, chat, payload)
        model = payload.get("model") or ""
        if model not in MODEL_CHOICES:
            model = ""
        attached = [k for k in ("include_code", "include_run") if payload.get(k, True)]
        chat["messages"].append({"role": "user", "text": text, "at": time.time(), "mode": mode,
                                 "attached": attached, "quick": payload.get("quick")})
        self.save(key, chat)
        emit({"type": "accepted"})
        result = self._run_claude(key, tdir, prompt, mode, model, chat.get("session_id"), emit)
        if result.get("resume_failed") and chat.get("session_id"):
            emit({"type": "notice", "text": "Старая сессия не найдена — начинаю новую с полным контекстом."})
            chat["session_id"] = None
            chat["ctx"] = {}
            prompt, mode = self.build_prompt(key, chat, payload)
            result = self._run_claude(key, tdir, prompt, mode, model, None, emit)
        if result.get("session_id") and not result.get("is_error"):
            chat["session_id"] = result["session_id"]
        msg = {"role": "assistant", "text": result.get("text") or "", "at": time.time(),
               "cost": result.get("cost"), "model": result.get("model"), "tools": result.get("tools", []),
               "error": result.get("error"), "duration_ms": result.get("duration_ms")}
        chat["messages"].append(msg)
        self.save(key, chat)
        emit(dict(result, type="done"))

    def _run_claude(self, key, tdir, prompt, mode, model, session_id, emit):
        app = self.app
        system = "%s\n\nПапка задачи: %s — читай файлы по абсолютным путям внутри неё.\n\n%s" % (
            SYSTEM_PROMPT_BASE, tdir, SYSTEM_PROMPT_MODES[mode])
        # cwd is a neutral per-task folder, not the repo: on start the CLI collects `git status`
        # of its cwd, which can take minutes on a big or slow repo. The task dir comes via --add-dir.
        # The folder is stable per task, so --resume finds the session again.
        cwd = app.data_dir / "claude" / key.replace("/", "__")
        cwd.mkdir(parents=True, exist_ok=True)
        args = [app.claude_bin, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--permission-mode", "dontAsk",
                "--strict-mcp-config", "--disable-slash-commands", "--add-dir", str(tdir),
                "--append-system-prompt", system]
        if session_id:
            args += ["--resume", session_id]
        if model:
            args += ["--model", model]
        try:
            proc = subprocess.Popen(args, cwd=str(cwd), env=claude_env(app.claude_bin), stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError as exc:
            return {"is_error": True, "error": "Не удалось запустить claude: %s" % exc, "text": ""}
        with self.lock:
            self.active[key] = proc
        err_chunks = []

        def pump_err():
            for chunk in iter(lambda: proc.stderr.read(4096), b""):
                err_chunks.append(chunk)
        threading.Thread(target=pump_err, daemon=True).start()
        killer = threading.Timer(600, lambda: kill_tree(proc))
        killer.start()
        try:
            proc.stdin.write(prompt.encode("utf-8"))
            proc.stdin.close()
        except OSError:
            pass
        full, streamed_ids, tools = "", set(), []
        result, model_used, sid, current_msg = None, None, session_id, None
        try:
            for raw in iter(proc.stdout.readline, b""):
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                t = ev.get("type")
                if ev.get("parent_tool_use_id"):
                    continue
                if t == "system" and ev.get("subtype") == "init":
                    sid = ev.get("session_id") or sid
                    model_used = ev.get("model")
                    emit({"type": "start", "model": model_used, "session_id": sid})
                elif t == "stream_event":
                    e = ev.get("event") or {}
                    et = e.get("type")
                    if et == "message_start":
                        current_msg = (e.get("message") or {}).get("id")
                    elif et == "content_block_start":
                        cb = e.get("content_block") or {}
                        if cb.get("type") == "text" and full and not full.endswith("\n\n"):
                            sep = "\n\n" if not full.endswith("\n") else "\n"
                            full += sep
                            emit({"type": "delta", "text": sep})
                        elif cb.get("type") == "tool_use":
                            emit({"type": "tool", "name": cb.get("name")})
                        elif cb.get("type") == "thinking":
                            emit({"type": "thinking"})
                    elif et == "content_block_delta":
                        d = e.get("delta") or {}
                        if d.get("type") == "text_delta" and d.get("text"):
                            if current_msg:
                                streamed_ids.add(current_msg)
                            full += d["text"]
                            emit({"type": "delta", "text": d["text"]})
                elif t == "assistant":
                    msg = ev.get("message") or {}
                    for block in msg.get("content") or []:
                        if block.get("type") == "tool_use":
                            inp = block.get("input") or {}
                            detail = inp.get("file_path") or inp.get("pattern") or inp.get("path") or ""
                            detail = str(detail).replace(str(tdir) + os.sep, "")
                            tools.append({"name": block.get("name"), "detail": detail})
                            emit({"type": "tool_input", "name": block.get("name"), "detail": detail})
                        elif block.get("type") == "text" and msg.get("id") not in streamed_ids and block.get("text"):
                            if full and not full.endswith("\n"):
                                full += "\n\n"
                            full += block["text"]
                            emit({"type": "delta", "text": block["text"]})
                elif t == "result":
                    result = ev
        except (BrokenPipeError, ConnectionResetError):
            kill_tree(proc)
            raise
        finally:
            killer.cancel()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                kill_tree(proc)
            with self.lock:
                if self.active.get(key) is proc:
                    self.active.pop(key, None)
        stderr = _dec(b"".join(err_chunks))
        out = {"text": full, "model": model_used, "session_id": sid, "tools": tools}
        if result is None:
            if session_id and re.search(r"No conversation found|session", stderr, re.I):
                out["resume_failed"] = True
            out["is_error"] = True
            out["error"] = stderr.strip()[-1500:] or "claude завершился без ответа (код %s)" % proc.returncode
            return out
        out.update({"is_error": bool(result.get("is_error")), "cost": result.get("total_cost_usd"),
                    "duration_ms": result.get("duration_ms"), "session_id": result.get("session_id") or sid})
        if not full and result.get("result"):
            out["text"] = result["result"]
        if out["is_error"]:
            msg = (result.get("result") or stderr or "").strip()
            out["error"] = msg[-1500:]
            if re.search(r"not logged in|/login|invalid api key|authentication", msg, re.I):
                out["auth_error"] = True
            if session_id and re.search(r"No conversation found", msg, re.I):
                out["resume_failed"] = True
        return out


# ---------------------------------------------------------------------------
# app & HTTP
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# leaderboard: the course's public Google Sheet
# ---------------------------------------------------------------------------

DEFAULT_LEADERBOARD = "https://docs.google.com/spreadsheets/d/1kT4C4dD8eqrtn7sfSrZ_KAl7_hEcBl9-ZWd2N1aLSXM/edit?gid=0#gid=0"
LB_META = {"sum": "sum", "percent (assignment)": "percent", "percent": "percent", "p1 (midterm)": "P1", "p1": "P1",
           "p2": "P2", "p3": "P3", "exam": "Exam", "final mark": "Final", "speakings": "Speakings",
           "bug reports": "Bug reports"}
LB_REFERENCE = {"perfect", "max", "maximum", "эталон", "максимум", "идеал"}
# Helper rows of the sheet (totals, averages, counters) — not students.
LB_META_RE = re.compile(r"(?i)^(total|sum|avg|average|mean|count|итого|всего|среднее)\b|_(solved|count|total|sum|avg)\b")


def sheet_csv_url(url):
    """Google Sheets link (edit/view/pub) -> CSV export URL; other http(s) URLs are taken as CSV."""
    url = (url or "").strip()
    m = re.search(r"docs\.google\.com/spreadsheets/d/([A-Za-z0-9_-]+)", url)
    if m and not ("/pub" in url and "output=csv" in url):
        g = re.search(r"[#&?]gid=(\d+)", url)
        return "https://docs.google.com/spreadsheets/d/%s/export?format=csv&gid=%s" % (m.group(1), g.group(1) if g else "0")
    return url if re.match(r"https?://", url) else None


def to_number(value):
    v = (value or "").strip().replace(" ", "").replace(",", ".").rstrip("%").strip()
    try:
        return float(v)
    except ValueError:
        return None


def http_get(url, timeout=20):
    """GET via urllib; fall back to curl (some Python builds ship without CA certificates)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "SegForces/" + VERSION})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.headers.get("Content-Type", ""), resp.read(8 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        raise ApiError(502, "Таблица ответила HTTP %s" % exc.code)
    except (urllib.error.URLError, OSError) as exc:
        if not shutil.which("curl"):
            raise ApiError(502, "Не удалось загрузить таблицу: %s" % exc)
        code, out, err = run_cmd(["curl", "-sSL", "--max-time", str(timeout), "-w", "\n%{content_type}", url],
                                 timeout=timeout + 5)
        if code != 0:
            raise ApiError(502, "Не удалось загрузить таблицу: %s" % (err.strip() or exc))
        body, _, ctype = out.rpartition("\n")
        return ctype, body.encode("utf-8")


class Leaderboard:
    TTL = 300

    def __init__(self, app):
        self.app = app
        self.lock = threading.Lock()
        self.cache = None
        self.cache_at = 0.0
        self.cache_url = None

    def source(self):
        return self.app.config.data.get("leaderboard_url") or DEFAULT_LEADERBOARD

    def me(self):
        me = self.app.config.data.get("leaderboard_me")
        if not me and self.app.judge and shutil.which("gh"):
            me = self.app.judge.user()  # cached after the first `gh api user`
        return me

    def get(self, force=False):
        csv_url = sheet_csv_url(self.source())
        if not csv_url:
            raise ApiError(400, "Не понимаю ссылку на таблицу лидерборда")
        with self.lock:
            fresh = self.cache and self.cache_url == csv_url and time.time() - self.cache_at < self.TTL
            if fresh and not force:
                return self._decorate(self.cache)
        try:
            ctype, raw = http_get(csv_url)
            if "html" in (ctype or "").lower():
                raise ApiError(403, "Таблица закрыта. Нужен доступ «всем, у кого есть ссылка» (или «Опубликовать в интернете»).")
            data = self.parse(raw.decode("utf-8-sig", "replace"))
        except ApiError as exc:
            with self.lock:
                if self.cache and self.cache_url == csv_url:
                    return self._decorate(dict(self.cache, stale=True, error=exc.message))
            raise
        data["fetched_at"] = time.time()
        with self.lock:
            self.cache, self.cache_at, self.cache_url = data, time.time(), csv_url
        return self._decorate(data)

    def _decorate(self, data):
        me = (self.me() or "").lower()
        rows = [dict(r, me=bool(me) and not r.get("meta") and r["user"].lower() == me) for r in data["rows"]]
        return dict(data, rows=rows, me=self.me(), source=self.source(), default=DEFAULT_LEADERBOARD)

    def parse(self, text):
        rows = list(csv.reader(io.StringIO(text)))
        if not rows or len(rows[0]) < 2:
            raise ApiError(502, "В таблице нет данных")
        header = [h.strip() for h in rows[0]]
        repo_tasks = {t["name"]: t for t in self.app.repo.all_tasks()} if self.app.repo else {}
        meta, tasks = {}, []
        for i, h in enumerate(header[1:], start=1):
            low = h.lower()
            if low in LB_META:
                meta[LB_META[low]] = i
            elif h in repo_tasks or (not repo_tasks and re.fullmatch(r"[a-z][a-z0-9_]+", h)):
                tasks.append(i)
        people = []
        for r in rows[1:]:
            name = (r[0] if r else "").strip()
            if not name:
                continue
            cell = (lambda i, r=r: r[i] if i < len(r) else "")
            scores = {}
            for i in tasks:
                v = to_number(cell(i))
                if v is not None:
                    scores[header[i]] = v
            total = to_number(cell(meta["sum"])) if "sum" in meta else None
            if total is None:
                total = sum(scores.values())
            people.append({
                "user": name, "sum": total,
                "percent": to_number(cell(meta["percent"])) if "percent" in meta else None,
                "scores": scores, "solved": sum(1 for v in scores.values() if v > 0),
                "marks": {k: cell(i).strip() for k, i in meta.items() if k not in ("sum", "percent") and cell(i).strip()},
                "reference": name.lower() in LB_REFERENCE,
                "meta": name.lower() not in LB_REFERENCE and bool(LB_META_RE.search(name)),
            })
        ranked = sorted((p for p in people if not p["reference"] and not p["meta"]), key=lambda p: -(p["sum"] or 0))
        place, prev = 0, None
        for i, p in enumerate(ranked, 1):
            if p["sum"] != prev:
                place, prev = i, p["sum"]
            p["rank"] = place
        refs = [p for p in people if p["reference"]]
        metas = [p for p in people if p["meta"]]
        task_names = [header[i] for i in tasks]
        return {
            "rows": refs + ranked + metas, "count": len(ranked), "tasks": task_names,
            "task_meta": {n: {"session": repo_tasks[n]["snum"], "letter": repo_tasks[n]["letter"],
                              "points": repo_tasks[n]["points"], "title": repo_tasks[n]["title"]}
                          for n in task_names if n in repo_tasks},
            "marks": [k for k in ("P1", "P2", "P3", "Exam", "Final", "Speakings", "Bug reports") if k in meta],
            "max_sum": max([p["sum"] or 0 for p in refs] or [0]) or None,
        }


class App:
    def __init__(self, args):
        self.args = args
        self.token = secrets.token_urlsafe(24)
        self.port = args.port
        self.lock = threading.RLock()
        self.config = JsonStore(config_dir() / "config.json",
                                {"repo": None, "leaderboard_url": None, "leaderboard_me": None})
        self.claude_bin = find_claude(args.claude_bin)
        self.env = Env(self)
        self.leaderboard = Leaderboard(self)
        self.repo = self.git = self.state = self.runner = self.console = self.judge = self.helper = None
        self.data_dir = None
        self.slug = None
        repo = find_repo(args.repo, self.config.data.get("repo"))
        if repo is not None:
            self.load_repo(repo)

    def load_repo(self, path):
        """(Re)bind everything that depends on the course repo — at startup or from the setup screen."""
        repo = Repo(path)
        data_dir = Path(self.args.data_dir) if self.args.data_dir else default_data_dir(repo.root)
        data_dir.mkdir(parents=True, exist_ok=True)
        with self.lock:
            self.repo = repo
            self.data_dir = data_dir
            self.git = Git(repo.root)
            self.slug = self.args.slug or slug_from_url(self.git.origin_url())
            self.state = JsonStore(data_dir / "state.json", {"runs": {}, "submissions": []})
            self.runner = Runner(self)
            self.console = Console(self)
            self.judge = Judge(self)
            self.helper = Helper(self)
            self.env.cache = None
        log("репозиторий:", repo.root, "| GitHub:", self.slug or "—")
        threading.Thread(target=lambda: self.judge.sync(force=True), daemon=True).start()

    # -- local run history -------------------------------------------------
    def state_add_run(self, key, run):
        with self.state.lock:
            lst = self.state.data["runs"].setdefault(key, [])
            lst.append(run)
            del lst[:-Runner.MAX_KEEP]
            self.state.save()

    def state_last_run(self, key):
        lst = self.state.data["runs"].get(key) or []
        return lst[-1] if lst else None

    def local_summary(self, key):
        lst = self.state.data["runs"].get(key) or []
        if not lst:
            return None
        last = lst[-1]
        return {
            "verdict": last.get("verdict"), "verdict_name": last.get("verdict_name"),
            "passed": last.get("passed"), "total": last.get("total"), "at": last.get("at"),
            "ever_ok": any(r.get("verdict") == "AC" for r in lst), "count": len(lst),
        }

    def overview(self, recheck=False):
        health = self.repo.health(force=recheck)
        sessions = self.repo.sessions(force=recheck)
        judge = self.judge.summary_by_task()
        pending = {}
        with self.state.lock:
            subs = list(self.state.data.get("submissions", []))
        for sub in subs:
            if isinstance(sub, dict) and isinstance(sub.get("key"), str):
                pending[sub["key"]] = sub
        total_points = earned = solved = tasks_count = 0
        for s in sessions:
            s_earned = 0
            for t in s["tasks"]:
                tasks_count += 1
                t["local"] = self.local_summary(t["key"])
                t["judge"] = judge.get(t["key"])
                sub = pending.get(t["key"])
                if sub and time.time() - (sub.get("at") or 0) < 1800:
                    last = (t["judge"] or {}).get("last")
                    if not last or (last.get("sha") != sub["sha"] and (last.get("created") or "") < sub.get("iso", "")):
                        t["pending"] = sub
                pts = t.get("points") or 0
                total_points += pts
                if t["judge"] and t["judge"]["solved"]:
                    earned += pts
                    s_earned += pts
                    solved += 1
            s["earned"] = s_earned
        activity = {}
        for item in self.judge.history():
            day = (item.get("created") or "")[:10]
            if day:
                activity[day] = activity.get(day, 0) + 1
        with self.state.lock:
            run_times = [r.get("at") or 0 for runs in self.state.data["runs"].values() for r in runs]
        for at in run_times:
            day = time.strftime("%Y-%m-%d", time.localtime(at))
            activity[day] = activity.get(day, 0) + 1
        return {
            "repo": {"path": str(self.repo.root), "name": self.repo.root.name, "slug": self.slug},
            "user": self.judge.store.data.get("user"),
            "sessions": sessions,
            "totals": {"points": total_points, "earned": earned, "solved": solved, "tasks": tasks_count},
            "activity": activity,
            "judge": {"available": self.judge.available(), "last_sync": self.judge.last_sync,
                      "error": self.judge.last_error},
            "repo_health": health,
            "now": time.time(),
        }


ROUTES = {}


def route(method, path):
    def deco(fn):
        ROUTES[(method, path)] = fn
        return fn
    return deco


def q1(query, name, default=None):
    vals = query.get(name)
    return vals[0] if vals else default


@route("GET", "/api/overview")
def r_overview(h, query, body):
    if q1(query, "sync") == "1":
        h.app.judge.sync(force=q1(query, "force") == "1")
    h.send_json(h.app.overview(recheck=q1(query, "recheck") == "1"))


@route("GET", "/api/env")
def r_env(h, query, body):
    h.send_json(h.app.env.check(force=q1(query, "force") == "1"))


@route("GET", "/api/leaderboard")
def r_leaderboard(h, query, body):
    h.send_json(h.app.leaderboard.get(force=q1(query, "force") == "1"))


@route("GET", "/api/config")
def r_config_get(h, query, body):
    app = h.app
    h.send_json({
        "repo": str(app.repo.root) if app.repo else None,
        "leaderboard_url": app.leaderboard.source(), "leaderboard_default": DEFAULT_LEADERBOARD,
        "leaderboard_me": app.config.data.get("leaderboard_me"),
        "data_dir": str(app.data_dir) if app.data_dir else None,
        "config_path": str(app.config.path), "version": VERSION, "platform": sys.platform,
    })


@route("POST", "/api/config")
def r_config_set(h, query, body):
    app = h.app
    with app.config.lock:
        if "leaderboard_url" in body:
            url = (body.get("leaderboard_url") or "").strip()
            if url and not sheet_csv_url(url):
                raise ApiError(400, "Это не похоже на ссылку на Google Таблицу или CSV")
            app.config.data["leaderboard_url"] = url or None
            app.leaderboard.cache = None
        if "leaderboard_me" in body:
            me = (body.get("leaderboard_me") or "").strip()
            app.config.data["leaderboard_me"] = me or None
        app.config.save()
    r_config_get(h, query, body)


@route("GET", "/api/setup/candidates")
def r_setup_candidates(h, query, body):
    h.send_json({"candidates": repo_candidates(), "current": str(h.app.repo.root) if h.app.repo else None,
                 "home": str(Path.home())})


@route("POST", "/api/setup/repo")
def r_setup_repo(h, query, body):
    raw = (body.get("path") or "").strip()
    if not raw:
        raise ApiError(400, "Укажи путь к папке репозитория")
    p = Path(raw).expanduser()
    try:
        p = p.resolve()
    except OSError:
        pass
    if not p.is_dir():
        raise ApiError(400, "Нет такой папки: %s" % p)
    if not looks_like_course_repo(p):
        raise ApiError(400, "В %s нет папок Session01, Session02… — это точно репозиторий Practice-*?" % p)
    app = h.app
    app.load_repo(p)
    with app.config.lock:
        app.config.data["repo"] = str(p)
        app.config.save()
    h.send_json({"ok": True, "repo": str(p)})


@route("GET", "/api/task")
def r_task(h, query, body):
    key = q1(query, "key")
    detail = h.app.repo.task_detail(key)
    detail["local_runs"] = [
        {k: v for k, v in r.items() if k != "output"} for r in (h.app.state.data["runs"].get(key) or [])][-15:]
    detail["judge"] = h.app.judge.history(key)
    h.send_json(detail)


@route("GET", "/api/file")
def r_file_get(h, query, body):
    key, rel = q1(query, "key"), q1(query, "path")
    p = h.app.repo.safe_path(key, rel)
    if not p.is_file():
        raise ApiError(404, "Файл не найден")
    data = read_bytes(p)
    if b"\0" in data[:8192] or len(data) > MAX_TEXT:
        raise ApiError(415, "Бинарный или слишком большой файл")
    st = p.stat()
    h.send_json({"path": rel, "content": _dec(data), "hash": sha1(data), "exec": bool(st.st_mode & 0o111),
                 "lang": lang_for(rel), "crlf": b"\r\n" in data})


@route("POST", "/api/file")
def r_file_save(h, query, body):
    key, rel = body.get("key"), body.get("path")
    content = body.get("content")
    if not isinstance(content, str):
        raise ApiError(400, "Нет содержимого")
    p = h.app.repo.safe_path(key, rel, for_write=True)
    base = body.get("base_hash")
    if p.exists():
        if p.is_dir():
            raise ApiError(409, "%s — это папка" % rel)
        cur = read_bytes(p)
        if base and sha1(cur) != base and not body.get("force"):
            raise ApiError(409, "Файл изменился на диске", code="conflict", disk_hash=sha1(cur),
                           disk_content=_dec(cur))
    data = content.encode("utf-8")
    p.parent.mkdir(parents=True, exist_ok=True)
    existed = p.exists()
    try:
        with open(p, "wb") as fh:
            fh.write(data)
    except OSError as exc:
        hint = " (нет прав на запись — проверь chmod)" if isinstance(exc, PermissionError) else ""
        raise ApiError(500, "Не удалось записать %s: %s%s" % (rel, exc.strerror or exc, hint))
    if not existed and rel.endswith(".sh"):
        os.chmod(str(p), 0o755)
    st = p.stat()
    h.send_json({"ok": True, "hash": sha1(data), "exec": bool(st.st_mode & 0o111), "size": len(data)})


@route("POST", "/api/file/create")
def r_file_create(h, query, body):
    key, rel = body.get("key"), (body.get("path") or "").strip()
    p = h.app.repo.safe_path(key, rel, for_write=True)
    if p.exists():
        raise ApiError(409, "%s уже существует" % rel)
    template = body.get("content")
    if template is None:
        if rel.endswith(".sh"):
            template = "#!/bin/bash\n\n"
        elif rel.endswith(".c"):
            template = "#include <stdio.h>\n\nint main(void) {\n    \n    return 0;\n}\n"
        elif rel.endswith(".h"):
            guard = re.sub(r"\W", "_", rel.rsplit("/", 1)[-1]).upper()
            template = "#ifndef %s\n#define %s\n\n\n\n#endif\n" % (guard, guard)
        elif rel.rsplit("/", 1)[-1] == "Makefile.Student":
            template = ("CC = gcc\nCFLAGS = -Wall -Wextra -std=c11 -g\n\n.PHONY: build clean\n\n"
                        "build:\n\t@echo \"TODO: собери программу\"\n\nclean:\n\trm -rf build\n")
        else:
            template = ""
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as fh:
        fh.write(template.encode("utf-8"))
    if rel.endswith(".sh"):
        os.chmod(str(p), 0o755)
    h.send_json({"ok": True, "path": rel})


@route("POST", "/api/file/chmod")
def r_file_chmod(h, query, body):
    key, rel = body.get("key"), body.get("path")
    p = h.app.repo.safe_path(key, rel, for_write=True)
    if not p.is_file():
        raise ApiError(404, "Файл не найден")
    mode = p.stat().st_mode
    if body.get("exec", True):
        mode |= (mode & 0o444) >> 2 | 0o100
    else:
        mode &= ~0o111
    os.chmod(str(p), mode)
    h.send_json({"ok": True, "exec": bool(p.stat().st_mode & 0o111)})


@route("POST", "/api/file/rmdir")
def r_file_rmdir(h, query, body):
    key, rel = body.get("key"), body.get("path")
    p = h.app.repo.safe_path(key, rel, for_write=True)
    if not p.is_dir():
        raise ApiError(404, "Это не папка")
    try:
        p.rmdir()
    except OSError:
        raise ApiError(409, "Папка не пустая — удали её вручную")
    h.send_json({"ok": True})


@route("POST", "/api/run")
def r_run(h, query, body):
    h.send_json(h.app.runner.start(body.get("key")))


@route("GET", "/api/run/stream")
def r_run_stream(h, query, body):
    run = h.app.runner.runs.get(q1(query, "id"))
    if not run:
        raise ApiError(404, "Прогон не найден")
    i = int(q1(query, "from", "0") or 0)
    h.start_stream()
    last_ping = time.time()
    while True:
        with run.cond:
            if i >= len(run.lines) and not run.done:
                run.cond.wait(timeout=2)
            chunk = run.lines[i:]
            i += len(chunk)
            done = run.done and i >= len(run.lines)
        if chunk:
            h.emit({"type": "lines", "lines": chunk, "elapsed": time.time() - run.started})
        elif time.time() - last_ping > 5:
            h.emit({"type": "ping", "elapsed": time.time() - run.started})
            last_ping = time.time()
        if done:
            h.emit({"type": "done", "result": run.result})
            return


@route("POST", "/api/run/cancel")
def r_run_cancel(h, query, body):
    h.send_json({"ok": h.app.runner.cancel(body.get("id"))})


@route("GET", "/api/run/output")
def r_run_output(h, query, body):
    key, rid = q1(query, "key"), q1(query, "id")
    for r in h.app.state.data["runs"].get(key) or []:
        if r.get("id") == rid:
            h.send_json(r)
            return
    raise ApiError(404, "Прогон не найден")


@route("POST", "/api/exec")
def r_exec(h, query, body):
    mode = body.get("mode") if body.get("mode") in ("docker", "local") else "docker"
    timeout = max(1, min(int(body.get("timeout") or 20), 120))
    h.send_json(h.app.console.execute(body.get("key"), body.get("cmd"), body.get("stdin"), mode, timeout))


@route("POST", "/api/submit/preflight")
def r_submit_preflight(h, query, body):
    key = body.get("key")
    h.app.repo.task(key)
    if not h.app.slug:
        raise ApiError(409, "У репозитория нет remote origin на GitHub")
    require_readable_repo(h.app)
    h.send_json(h.app.git.preflight(key))


def require_readable_repo(app):
    health = app.repo.health()
    if not health["ok"]:
        raise ApiError(503, "Файлы репозитория сейчас не читаются, git тоже их не прочитает. "
                            "Подожди немного и повтори.",
                       hint=health.get("error"))


def _submit_common(h, fn):
    h.start_stream()

    def emit(obj):
        h.emit(obj)
    try:
        sha = fn(emit)
    except ApiError as exc:
        h.emit(dict({"type": "error", "message": exc.message}, **exc.extra))
        return None
    except Exception as exc:
        traceback.print_exc()
        h.emit({"type": "error", "message": str(exc)})
        return None
    return sha


@route("POST", "/api/submit")
def r_submit(h, query, body):
    app = h.app
    key = body.get("key")
    app.repo.task(key)
    require_readable_repo(app)
    paths = body.get("files") or []
    if not isinstance(paths, list):
        raise ApiError(400, "files должен быть списком")
    sha = _submit_common(h, lambda emit: app.git.submit(key, paths, bool(body.get("allow_empty")), emit))
    if sha:
        sub = {"key": key, "sha": sha, "at": time.time(),
               "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": paths}
        with app.state.lock:
            subs = app.state.data.setdefault("submissions", [])
            subs.append(sub)
            del subs[:-200]
            app.state.save()
        log("[submit]", key, sha[:8])
        h.emit({"type": "done", "sha": sha, "key": key})


@route("POST", "/api/git/unlock")
def r_git_unlock(h, query, body):
    git = h.app.git
    st = git.lock_state()
    if st is None:
        h.send_json({"ok": True, "removed": False})
        return
    if not st["stale"]:
        raise ApiError(409, "Блокировку держит работающий git-процесс (или она только что появилась) — подожди и повтори.")
    try:
        os.remove(str(git.lock_path()))
    except FileNotFoundError:
        pass
    log("[git] удалён зависший index.lock (возраст %d с)" % st["age"])
    h.send_json({"ok": True, "removed": True})


@route("POST", "/api/submit/push")
def r_submit_push(h, query, body):
    app = h.app
    key = body.get("key")
    app.repo.task(key)

    def do(emit):
        if not app.git.lock.acquire(blocking=False):
            raise ApiError(409, "Уже идёт отправка")
        try:
            return app.git.push(emit)
        finally:
            app.git.lock.release()
    sha = _submit_common(h, do)
    if sha:
        with app.state.lock:
            app.state.data.setdefault("submissions", []).append({
                "key": key, "sha": sha, "at": time.time(),
                "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": []})
            app.state.save()
        h.emit({"type": "done", "sha": sha, "key": key})


@route("POST", "/api/judge/sync")
def r_judge_sync(h, query, body):
    ok = h.app.judge.sync(force=bool(body.get("force")))
    h.send_json({"ok": ok, "error": h.app.judge.last_error})


@route("GET", "/api/judge/history")
def r_judge_history(h, query, body):
    items = h.app.judge.history(q1(query, "key"))
    h.send_json({"items": list(reversed(items))[:300]})


@route("GET", "/api/judge/run")
def r_judge_run(h, query, body):
    h.send_json(h.app.judge.run_detail(q1(query, "id"), q1(query, "key")))


@route("GET", "/api/judge/commit")
def r_judge_commit(h, query, body):
    h.send_json(h.app.judge.poll_commit(q1(query, "sha")))


@route("GET", "/api/chat")
def r_chat_get(h, query, body):
    key = q1(query, "key")
    h.app.repo.task(key)
    chat = h.app.helper.load(key)
    h.send_json({"messages": chat.get("messages", []), "session_id": chat.get("session_id")})


@route("POST", "/api/chat")
def r_chat(h, query, body):
    key = body.get("key")
    h.app.repo.task(key)
    h.start_stream()
    try:
        h.app.helper.ask(key, body, h.emit)
    except ApiError as exc:
        h.emit(dict({"type": "error", "message": exc.message}, **exc.extra))
    except (BrokenPipeError, ConnectionResetError):
        h.app.helper.stop(key)
    except Exception as exc:
        traceback.print_exc()
        h.emit({"type": "error", "message": str(exc)})


@route("POST", "/api/chat/stop")
def r_chat_stop(h, query, body):
    h.send_json({"ok": h.app.helper.stop(body.get("key"))})


@route("POST", "/api/chat/reset")
def r_chat_reset(h, query, body):
    key = body.get("key")
    h.app.repo.task(key)
    h.app.helper.reset(key)
    h.send_json({"ok": True})


@route("POST", "/api/chat/prompt")
def r_chat_prompt(h, query, body):
    key = body.get("key")
    chat = {"session_id": None, "messages": [], "ctx": {}}
    prompt, mode = h.app.helper.build_prompt(key, chat, dict(body, full_context=True))
    system = SYSTEM_PROMPT_BASE + "\n\n" + SYSTEM_PROMPT_MODES[mode]
    h.send_json({"prompt": system + "\n\n---\n\n" + prompt})


@route("POST", "/api/lint")
def r_lint(h, query, body):
    sc = shutil.which("shellcheck")
    if not sc:
        h.send_json({"available": False, "comments": []})
        return
    code, out, err = run_cmd([sc, "-f", "json1", "-s", "bash", "-"], input_text=body.get("content") or "", timeout=15)
    try:
        comments = json.loads(out or "{}").get("comments", [])
    except ValueError:
        comments = []
    h.send_json({"available": True, "comments": comments[:300]})


@route("POST", "/api/reveal")
def r_reveal(h, query, body):
    key = body.get("key")
    target = h.app.repo.task_dir(key)
    if body.get("path"):
        target = h.app.repo.safe_path(key, body["path"])
    if sys.platform == "darwin":
        run_cmd(["open", "-R", str(target)], timeout=10)
    else:
        run_cmd(["xdg-open", str(target if target.is_dir() else target.parent)], timeout=10)
    h.send_json({"ok": True})


@route("POST", "/api/docker/start")
def r_docker_start(h, query, body):
    if sys.platform != "darwin":
        raise ApiError(400, "Запусти Docker сам: `sudo systemctl start docker` (Linux) или открой Docker Desktop.")
    code, out, err = run_cmd(["open", "-a", "Docker"], timeout=15)
    if code != 0:
        raise ApiError(500, "Не получилось открыть Docker Desktop: %s" % (err or out)[-300:])
    h.app.env.docker_cache = (0.0, None)
    h.send_json({"ok": True})


@route("POST", "/api/docker/restart")
def r_docker_restart(h, query, body):
    """Docker Desktop stuck (API does not answer): quit it and start again."""
    if sys.platform != "darwin":
        raise ApiError(400, "Перезапусти Docker сам: `sudo systemctl restart docker` (Linux) или через Docker Desktop.")

    def docker_pids():
        code, out, _e = run_cmd(["pgrep", "-f", "/Applications/Docker.app/Contents/MacOS/"], timeout=5)
        return [int(x) for x in out.split() if x.isdigit()] if code == 0 else []

    def work():
        # 1) ask politely; a frozen Docker Desktop ignores this (and `docker desktop restart`)
        run_cmd(["osascript", "-e", 'quit app "Docker"'], timeout=10)
        for _ in range(15):
            if not docker_pids():
                break
            time.sleep(1)
        # 2) whatever is left is stuck: TERM, then KILL
        for sig in (signal.SIGTERM, signal.SIGKILL):
            pids = docker_pids()
            if not pids:
                break
            for pid in pids:
                try:
                    os.kill(pid, sig)
                except OSError:
                    pass
            time.sleep(4)
        left = docker_pids()
        run_cmd(["open", "-a", "Docker"], timeout=15)
        h.app.env.docker_cache = (0.0, None)
        log("[docker] перезапуск: %s" % ("старые процессы остались: %s" % left if left else "ok"))
    threading.Thread(target=work, daemon=True).start()
    h.send_json({"ok": True})


NO_REPO_ROUTES = {"/api/env", "/api/config", "/api/leaderboard", "/api/setup/candidates", "/api/setup/repo",
                  "/api/docker/start", "/api/docker/restart"}

MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
        ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2"}

CSP = ("default-src 'self'; "
       "script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; "
       "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; "
       "img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'self' blob: data:; "
       "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")


class Handler(BaseHTTPRequestHandler):
    server_version = "SegForces/" + VERSION
    app = None  # set in main()

    def log_message(self, fmt, *args):
        if self.app.args.verbose:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # -- responses -------------------------------------------------------
    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def start_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()

    def emit(self, obj):
        self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        self.wfile.flush()

    # -- security --------------------------------------------------------
    def host_ok(self):
        host = (self.headers.get("Host") or "").lower()
        allowed = {"127.0.0.1:%d" % self.app.port, "localhost:%d" % self.app.port, "[::1]:%d" % self.app.port}
        return host in allowed

    def origin_ok(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return origin.lower() in ("http://127.0.0.1:%d" % self.app.port, "http://localhost:%d" % self.app.port,
                                  "http://[::1]:%d" % self.app.port)

    # -- dispatch --------------------------------------------------------
    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def dispatch(self, method):
        try:
            if not self.host_ok():
                self.send_error(403, "Bad Host")
                return
            url = urlparse(self.path)
            if not url.path.startswith("/api/"):
                if method != "GET":
                    self.send_error(405)
                    return
                self.serve_static(url.path)
                return
            if self.headers.get("X-SegForces-Token") != self.app.token or not self.origin_ok():
                self.send_json({"error": "Нет доступа: обнови страницу (сервер мог перезапуститься)",
                                "code": "token"}, 403)
                return
            body = {}
            if method == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                if length > 8 * 1024 * 1024:
                    self.send_json({"error": "Слишком большой запрос"}, 413)
                    return
                raw = self.rfile.read(length) if length else b""
                if raw:
                    try:
                        body = json.loads(raw.decode("utf-8"))
                    except ValueError:
                        self.send_json({"error": "Некорректный JSON"}, 400)
                        return
            fn = ROUTES.get((method, url.path))
            if not fn:
                self.send_json({"error": "Нет такого метода API"}, 404)
                return
            if self.app.repo is None and url.path not in NO_REPO_ROUTES:
                self.send_json({"error": "Сначала выбери папку репозитория курса", "code": "no_repo"}, 409)
                return
            fn(self, parse_qs(url.query), body if isinstance(body, dict) else {})
        except ApiError as exc:
            try:
                self.send_json(dict({"error": exc.message}, **exc.extra), exc.status)
            except (BrokenPipeError, ConnectionResetError):
                pass
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            traceback.print_exc()
            try:
                self.send_json({"error": "Внутренняя ошибка сервера: %s" % exc}, 500)
            except Exception:
                pass

    def serve_static(self, path):
        if path in ("/", "/index.html"):
            target = STATIC_DIR / "index.html"
        elif path.startswith("/static/"):
            target = (STATIC_DIR / path[len("/static/"):]).resolve()
            if not str(target).startswith(str(STATIC_DIR.resolve()) + os.sep):
                self.send_error(404)
                return
        elif path == "/favicon.ico":
            target = STATIC_DIR / "favicon.svg"
        else:
            self.send_error(404)
            return
        if not target.is_file():
            self.send_error(404)
            return
        try:
            data = read_bytes(target)
        except OSError as exc:
            self.send_error(503, "Cannot read %s: %s" % (target.name, exc))
            return
        ctype = MIME.get(target.suffix, "application/octet-stream")
        if target.name == "index.html":
            data = data.replace(b"__SEGFORCES_TOKEN__", self.app.token.encode())
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if target.name == "index.html":
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(data)


def looks_like_course_repo(path):
    try:
        p = Path(path)
        return p.is_dir() and any(d.is_dir() and SESSION_RE.match(d.name) for d in p.iterdir())
    except OSError:
        return False


def find_repo(explicit, configured=None):
    """--repo > saved choice > a Practice-* repo next to SegForces or in the current dir."""
    if explicit:
        p = Path(explicit).expanduser().resolve()
        if not looks_like_course_repo(p):
            sys.exit("В %s нет папок SessionXX — это точно репозиторий курса?" % p)
        return p
    if configured and looks_like_course_repo(configured):
        return Path(configured)
    for base in (Path.cwd(), APP_DIR.parent, Path.cwd().parent):
        if looks_like_course_repo(base) and (base / ".git").exists():
            return base.resolve()
        try:
            for d in sorted(base.iterdir()):
                if d.is_dir() and (d / ".git").exists() and looks_like_course_repo(d):
                    return d.resolve()
        except OSError:
            continue
    return None


SKIP_SEARCH = {"Library", "node_modules", ".git", ".cache", ".npm", ".nvm", ".pyenv", ".Trash", "Applications",
               "Pictures", "Music", "Movies", ".docker", ".local", ".cargo", ".rustup", "go", "venv", ".venv"}


def repo_candidates(limit_dirs=30000, max_depth=6, budget=6.0):
    """Course repos (git repos with SessionXX inside) under $HOME, for the setup screen.

    Breadth-first with os.scandir; directories named Practice* are checked first, and
    usual project folders are walked before the rest of the home directory."""
    home = Path.home()
    found, seen, started = [], 0, time.time()

    def check(path):
        try:
            if (path / ".git").exists() and looks_like_course_repo(path):
                rp = str(path.resolve())
                if rp not in found:
                    found.append(rp)
                return True
        except OSError:
            pass
        return False

    likely = ["Documents", "Desktop", "dev", "Developer", "projects", "Projects", "code", "Code", "src",
              "repos", "github", "GitHub", "git", "study", "uni", "university", "work", "Downloads"]
    roots = [APP_DIR.parent, home] + [home / n for n in likely]
    queue = [(r, 0) for r in roots if r.is_dir()]
    visited = set()
    while queue and seen < limit_dirs and time.time() - started < budget:
        if found and time.time() - started > 2.0:
            break
        d, depth = queue.pop(0)
        key = str(d)
        if key in visited:
            continue
        visited.add(key)
        seen += 1
        try:
            entries = sorted(os.scandir(key), key=lambda e: e.name)
        except OSError:
            continue
        later = []
        for e in entries:
            if e.name.startswith(".") or e.name in SKIP_SEARCH:
                continue
            try:
                if not e.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            p = Path(e.path)
            if e.name.lower().startswith("practice") and check(p):
                continue
            if depth + 1 <= max_depth:
                later.append((p, depth + 1))
        # repos are never inside repos: don't descend into the one we just found
        if not check(d):
            queue.extend(later)
    return found[:20]


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description="SegForces — локальный judge для Practice-репозитория")
    ap.add_argument("--repo", help="путь к репозиторию Practice-*")
    ap.add_argument("--port", type=int, default=int(os.environ.get("SEGFORCES_PORT", DEFAULT_PORT)))
    ap.add_argument("--open", action="store_true", help="открыть браузер после запуска")
    ap.add_argument("--data-dir", help="куда сохранять историю (по умолчанию ~/Library/Application Support/SegForces/<repo>)")
    ap.add_argument("--slug", help="owner/repo на GitHub (по умолчанию из git remote origin)")
    ap.add_argument("--claude-bin", help="путь к claude CLI")
    ap.add_argument("--run-timeout", type=int, default=900, help="лимит на прогон тестов, с")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    augment_path()
    httpd = None
    for port in range(args.port, args.port + 10):
        try:
            httpd = Server(("127.0.0.1", port), Handler)
            args.port = port
            break
        except OSError:
            continue
    if httpd is None:
        sys.exit("Порты %d–%d заняты. Запусти с --port <другой>." % (args.port, args.port + 9))
    log("SegForces %s" % VERSION)
    app = App(args)
    Handler.app = app
    url = "http://localhost:%d/" % args.port
    if app.repo is None:
        log("репозиторий не найден — выбери его на странице, которая откроется")
    log("claude:", app.claude_bin or "не найден")
    log("открой", url)
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        log("пока!")


if __name__ == "__main__":
    main()
