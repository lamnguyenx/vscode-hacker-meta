#!/usr/bin/env python3
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REFS = ROOT / "_refs"

def load(path: Path) -> dict:
    pkg = json.loads((path / "package.json").read_text())
    return {"folder": path.name, "name": pkg["name"],
            "publisher": pkg["publisher"], "version": pkg["version"]}

def render(rows: list[dict]) -> str:
    keys = list(rows[0].keys())
    w = [max(len(k), max(len(r[k]) for r in rows)) for k in keys]
    def line(v): return " | ".join(f"{c:<{w[i]}}" for i, c in enumerate(v))
    sep = " | ".join("-" * w[i] for i in range(len(keys)))
    return "\n".join([f"| {line(keys)} |", f"| {sep} |"] +
                     [f"| {line(r.values())} |" for r in rows])

def main():
    projects = sorted(p for p in REFS.iterdir() if (p / "package.json").is_file())
    print(render([load(p) for p in projects]))

if __name__ == "__main__":
    main()