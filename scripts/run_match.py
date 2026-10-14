#!/usr/bin/env python3
"""Keep the original batch command and import interface available."""
from pathlib import Path
import runpy

_implementation = runpy.run_path(str(Path(__file__).resolve().parents[1] / "skills" / "job-resume-intelligent-matching-fanhan" / "scripts" / "run_match.py"))
globals().update({name: value for name, value in _implementation.items() if not name.startswith("__")})

if __name__ == "__main__":
    main()
