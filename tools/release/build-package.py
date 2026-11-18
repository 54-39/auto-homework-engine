import os, json, zipfile, fnmatch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VERSION = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))["version"]
OUT = os.path.join(ROOT, "dist", "homework-helper-" + VERSION + ".zip")
SKIP_DIRS = {".git", "node_modules", "dist", "design-preview", ".native-runtime", "archive-handoff", ".codex", ".agents", ".workbuddy"}
SKIP_FILES = {"hot-reload.json", ".crinfo", ".update-state.json", ".update-files.json", "native-host.exe"}
SKIP_GLOBS = ["HANDOFF*", "TASK-*.md", "REPORT-*.md", "*.log", ".native-host*.json", ".env", ".env.*", ".tmp*", ".update-*"]


def skip_dir(name):
    return name in SKIP_DIRS or name.startswith(".tmp") or name.startswith(".update-")


def skip_file(name):
    return name in SKIP_FILES or any(fnmatch.fnmatch(name, g) for g in SKIP_GLOBS)


files = []
for dp, dirs, names in os.walk(ROOT):
    dirs[:] = [d for d in dirs if not skip_dir(d)]
    for n in names:
        if skip_file(n):
            continue
        p = os.path.join(dp, n)
        rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
        if rel.startswith("_locales/_locales/"):
            continue
        files.append((p, rel))
files.sort(key=lambda x: x[1])

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, 9) as z:
    for p, rel in files:
        z.write(p, "auto-homework-engine/" + rel)

print("version", VERSION)
print("entries", len(files))
print("size", os.path.getsize(OUT))
