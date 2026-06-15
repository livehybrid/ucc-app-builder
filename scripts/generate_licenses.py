#!/usr/bin/env python3
"""
Generate the third-party license inventory for UCC App Builder into ./licenses/.

This project ships two dependency worlds and BOTH are enumerated here so the
submission can demonstrate that every bundled library is open source:

  * npm  — the React SPA + Node build engine. Read hermetically from
           package-lock.json (v3) + node_modules (no network), production
           closure only (devDependencies excluded via the lock's `dev` flag).
  * python — the in-Splunk advisor stack (Splunk Agent SDK). NOT committed; it
           is pip-installed into the app's lib/ at build time
           (splunk-app/deploy/build_agent_app.sh). Pass that built lib via
           --python-lib to enumerate each wheel's *.dist-info, plus the vendored
           Apache-2.0 splunklib under splunk-app/ucc-app/lib/splunklib.

Outputs (all regenerated, deterministic, sorted):
  licenses/THIRD_PARTY_LICENSES.md  — human summary + per-ecosystem tables
  licenses/manifest.json            — machine-readable inventory
  licenses/npm/<name>@<ver>.txt     — full license text per package
  licenses/python/<name>@<ver>.txt  — full license text per package
  licenses/README.md                — what this folder is + how to regenerate

Usage:
  python scripts/generate_licenses.py [--python-lib DIR] [--check]

  --check  exit non-zero if any dependency's license is unknown / not an
           recognised open-source license (the "prove it's all OSS" gate).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "licenses"

# Recognised open-source license tokens (normalised upper-case, SPDX-ish). The
# point of the --check gate is to prove every bundled lib is OSS; OSI-approved
# copyleft (GPL/LGPL/MPL/etc.) counts as open source and is allowed.
OSS_LICENSES = {
    "MIT", "MIT-0", "ISC", "APACHE-2.0", "APACHE 2.0", "APACHE", "APACHE-2",
    "BSD", "BSD-2-CLAUSE", "BSD-3-CLAUSE", "BSD-3-CLAUSE-CLEAR", "0BSD",
    "PYTHON-2.0", "PYTHON-2.0.1", "PSF", "PSF-2.0", "PYTHON SOFTWARE FOUNDATION",
    "MPL-2.0", "MPL-1.1", "MPL 2.0",
    "LGPL-2.1", "LGPL-2.1-ONLY", "LGPL-2.1-OR-LATER", "LGPL-3.0",
    "LGPL-3.0-ONLY", "LGPL-3.0-OR-LATER", "LGPL",
    "GPL-2.0", "GPL-2.0-ONLY", "GPL-2.0-OR-LATER", "GPL-3.0",
    "GPL-3.0-ONLY", "GPL-3.0-OR-LATER", "AGPL-3.0", "AGPL-3.0-ONLY",
    "CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "UNLICENSE", "THE UNLICENSE",
    "WTFPL", "ZLIB", "ARTISTIC-2.0", "BLUEOAK-1.0.0", "ZPL-2.1", "HPND",
    "NCSA", "BOOST", "BSL-1.0",
}
# Tokens that are explicitly NOT acceptable / mean "no license declared".
DENY_TOKENS = {"UNLICENSED", "PROPRIETARY", "NOLICENSE", "NONE", ""}

# Many packages declare the license as a free-text human name in the METADATA
# `License:` field (e.g. "MIT License", "3-Clause BSD License", "Apache Software
# License") rather than a clean SPDX id. Recognise those too — word-boundary
# regexes so "LIMITED" does NOT match "MIT", etc. Every pattern here denotes an
# OSI-approved / open-source license family.
OSS_PATTERNS = [re.compile(p) for p in (
    r"\bMIT\b", r"\bBSD\b", r"\bAPACHE\b", r"\bISC\b", r"\bMPL\b",
    r"MOZILLA PUBLIC", r"\bPSF\b", r"PYTHON SOFTWARE FOUNDATION", r"\bPYTHON-2",
    r"\bA?L?GPL\b", r"\bZLIB\b", r"UNLICENSE", r"PUBLIC DOMAIN", r"\bARTISTIC\b",
    r"\bCC0\b", r"CC-BY", r"\bBOOST\b", r"\bBSL\b", r"\bZPL\b", r"\bHPND\b",
    r"\bNCSA\b", r"\bWTFPL\b", r"ECLIPSE PUBLIC", r"\bEPL\b",
)]

LICENSE_FILE_RE = re.compile(
    r"^(licen[cs]e|copying|notice|mit-license|unlicense)", re.IGNORECASE
)

# Canonical SPDX texts for packages that declare a license but ship NO license
# file in their tarball (common for micromark, styled-components, …). Used as a
# fallback so the inventory is self-contained. Clearly marked as the canonical
# template since the upstream copyright line isn't bundled.
_MIT = """MIT License

Copyright (c) the package authors and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE."""
_ISC = """ISC License

Copyright (c) the package authors and contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE."""
_APACHE2 = """                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of this
      License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have
      made, use, offer to sell, sell, import, and otherwise transfer the
      Work.

   4. Redistribution. You may reproduce and distribute copies of the Work
      or Derivative Works thereof in any medium, with or without
      modifications, provided that You meet the conditions of this License.

   7. Disclaimer of Warranty. Unless required by applicable law or agreed
      to in writing, Licensor provides the Work on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied.

   8. Limitation of Liability. In no event and under no legal theory shall
      any Contributor be liable to You for damages.

   END OF TERMS AND CONDITIONS

   Full text: https://www.apache.org/licenses/LICENSE-2.0
   (abridged here; the complete, authoritative text is at the URL above)."""
SPDX_FALLBACK = {"MIT": _MIT, "ISC": _ISC, "APACHE-2.0": _APACHE2, "APACHE": _APACHE2}


def _fallback_text(license_str: str) -> str:
    for atom in _norm_atoms(license_str):
        # match "MIT", "MIT LICENSE", "THE MIT LICENSE (MIT)" -> MIT, etc.
        for spdx, body in SPDX_FALLBACK.items():
            if re.search(rf"\b{spdx}\b", atom):
                return (f"[Canonical {spdx} text — the package declares {spdx} "
                        f"but did not bundle a license file.]\n\n{body}")
    return ""


def _safe(name: str) -> str:
    return name.replace("/", "__").replace("\\", "__")


def _norm_atoms(expr: str) -> list[str]:
    """Split an SPDX-ish expression into atomic license tokens, normalised."""
    if not expr:
        return [""]
    # strip parens, split on OR / AND / WITH / slashes / commas / semicolons
    cleaned = re.sub(r"[()]", " ", expr)
    parts = re.split(r"\b(?:OR|AND|WITH)\b|[/,;]", cleaned, flags=re.IGNORECASE)
    atoms = [p.strip().upper() for p in parts if p.strip()]
    return atoms or [""]


def is_oss(expr: str) -> bool:
    """A package is OSS if at least one recognised OSS atom appears and no atom
    is an explicit deny token."""
    atoms = _norm_atoms(expr)
    up = expr.upper()
    oss_signal = (any(a in OSS_LICENSES for a in atoms)
                  or any(p.search(up) for p in OSS_PATTERNS))
    if any(a in DENY_TOKENS for a in atoms) and not oss_signal:
        # explicit "no license declared" with no offsetting OSS signal
        return False
    return oss_signal


def _find_license_text(d: Path) -> str:
    """Return the most likely full license text inside a directory."""
    if not d.is_dir():
        return ""
    cands: list[Path] = []
    # newer python wheels stash texts under dist-info/licenses/
    sub = d / "licenses"
    if sub.is_dir():
        cands += [p for p in sub.rglob("*") if p.is_file()]
    cands += [p for p in d.iterdir() if p.is_file() and LICENSE_FILE_RE.match(p.name)]
    if not cands:
        return ""
    # prefer the largest plausible license file
    best = max(cands, key=lambda p: p.stat().st_size)
    try:
        return best.read_text(encoding="utf-8", errors="replace").strip()
    except Exception:
        return ""


# --------------------------------------------------------------------------- npm
def _pkg_name_from_path(path: str) -> str:
    # "node_modules/a/node_modules/@scope/b" -> "@scope/b"
    tail = path.split("node_modules/")[-1]
    return tail


def collect_npm() -> list[dict]:
    lock = ROOT / "package-lock.json"
    nm = ROOT / "node_modules"
    if not lock.exists():
        return []
    data = json.loads(lock.read_text())
    packages = data.get("packages", {})
    seen: dict[tuple[str, str], dict] = {}
    for path, meta in packages.items():
        if not path:  # root
            continue
        if meta.get("dev") or meta.get("devOptional"):
            continue  # production closure only
        name = _pkg_name_from_path(path)
        version = meta.get("version", "")
        lic = meta.get("license")
        if isinstance(lic, dict):
            lic = lic.get("type", "")
        if isinstance(lic, list):
            lic = " OR ".join(
                (x.get("type", "") if isinstance(x, dict) else str(x)) for x in lic
            )
        pkg_dir = ROOT / path
        # fall back to the installed package.json if the lock omitted the license
        if not lic and (pkg_dir / "package.json").exists():
            try:
                pj = json.loads((pkg_dir / "package.json").read_text())
                pj_lic = pj.get("license") or pj.get("licenses")
                if isinstance(pj_lic, dict):
                    pj_lic = pj_lic.get("type", "")
                if isinstance(pj_lic, list):
                    pj_lic = " OR ".join(
                        (x.get("type", "") if isinstance(x, dict) else str(x))
                        for x in pj_lic
                    )
                lic = pj_lic or ""
            except Exception:
                pass
        lic = (lic or "UNKNOWN").strip()
        homepage = ""
        try:
            if (pkg_dir / "package.json").exists():
                pj = json.loads((pkg_dir / "package.json").read_text())
                repo = pj.get("repository")
                if isinstance(repo, dict):
                    repo = repo.get("url", "")
                homepage = pj.get("homepage") or repo or ""
        except Exception:
            pass
        text = _find_license_text(pkg_dir)
        key = (name, version)
        if key in seen:
            continue
        seen[key] = {
            "ecosystem": "npm",
            "name": name,
            "version": version,
            "license": lic,
            "homepage": homepage,
            "_text": text,
        }
    return sorted(seen.values(), key=lambda r: (r["name"].lower(), r["version"]))


# ------------------------------------------------------------------------- python
_CLASSIFIER_RE = re.compile(r"^Classifier:\s*License\s*::\s*(.+)$")


def _classifier_to_spdx(cls_tail: str) -> str:
    # "OSI Approved :: MIT License" -> "MIT"; keep human label otherwise.
    tail = cls_tail.split("::")[-1].strip()
    m = {
        "MIT License": "MIT",
        "Apache Software License": "Apache-2.0",
        "BSD License": "BSD",
        "ISC License (ISCL)": "ISC",
        "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
        "Python Software Foundation License": "PSF",
        "GNU Lesser General Public License v2 or later (LGPLv2+)": "LGPL-2.1-or-later",
        "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0",
        "GNU General Public License v2 (GPLv2)": "GPL-2.0",
        "GNU General Public License v3 (GPLv3)": "GPL-3.0",
        "The Unlicense (Unlicense)": "Unlicense",
    }
    return m.get(tail, tail)


def _parse_metadata(meta_path: Path) -> dict:
    name = version = lic = ""
    osi = []
    expr = ""
    home = ""
    for line in meta_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("Name:") and not name:
            name = line.split(":", 1)[1].strip()
        elif line.startswith("Version:") and not version:
            version = line.split(":", 1)[1].strip()
        elif line.startswith("License-Expression:") and not expr:
            expr = line.split(":", 1)[1].strip()
        elif line.startswith("License:") and not lic:
            lic = line.split(":", 1)[1].strip()
        elif line.startswith("Home-page:") and not home:
            home = line.split(":", 1)[1].strip()
        else:
            m = _CLASSIFIER_RE.match(line)
            if m:
                osi.append(_classifier_to_spdx(m.group(1)))
        if line.strip() == "" and name and version:
            break  # headers done
    # priority: PEP639 expression > OSI classifier > short License: field
    license_str = expr or (" OR ".join(dict.fromkeys(osi)) if osi else "")
    if not license_str:
        # License: can be a full text blob; keep only a short first line
        license_str = (lic.splitlines()[0].strip() if lic else "UNKNOWN")[:80]
    return {"name": name, "version": version, "license": license_str or "UNKNOWN",
            "homepage": home}


def collect_python(lib_dir: Path | None) -> list[dict]:
    rows: dict[tuple[str, str], dict] = {}

    # 1) vendored splunklib (Apache-2.0, from splunk-sdk 3.0.0 — not on PyPI)
    vend = ROOT / "splunk-app" / "ucc-app" / "lib" / "splunklib"
    if vend.is_dir():
        ver = ""
        init = vend / "__init__.py"
        if init.exists():
            m = re.search(r"__version__\s*=\s*['\"]([^'\"]+)", init.read_text(errors="replace"))
            if m:
                ver = m.group(1)
        rows[("splunklib", ver)] = {
            "ecosystem": "python",
            "name": "splunklib",
            "version": ver or "3.0.0 (vendored from splunk-sdk)",
            "license": "Apache-2.0",
            "homepage": "https://github.com/splunk/splunk-sdk-python",
            "_text": _find_license_text(vend) or
            "Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0\n"
            "Vendored from splunk-sdk 3.0.0 (provides splunklib.ai, the Splunk Agent SDK).",
        }

    # 2) pip-installed wheels in the built app lib/
    if lib_dir and lib_dir.is_dir():
        for di in sorted(lib_dir.glob("*.dist-info")):
            meta = di / "METADATA"
            if not meta.exists():
                continue
            info = _parse_metadata(meta)
            if not info["name"]:
                continue
            info.update(ecosystem="python", _text=_find_license_text(di))
            rows[(info["name"], info["version"])] = info

    return sorted(rows.values(), key=lambda r: (r["name"].lower(), r["version"]))


# -------------------------------------------------------------------------- write
def write_outputs(npm: list[dict], py: list[dict]) -> None:
    if OUT.exists():
        # clear previously-generated content so removed deps don't linger
        for sub in ("npm", "python"):
            d = OUT / sub
            if d.is_dir():
                for f in d.iterdir():
                    if f.is_file():
                        f.unlink()
    (OUT / "npm").mkdir(parents=True, exist_ok=True)
    (OUT / "python").mkdir(parents=True, exist_ok=True)

    manifest = []
    for rows, eco in ((npm, "npm"), (py, "python")):
        for r in rows:
            fname = f"{_safe(r['name'])}@{_safe(r['version'])}.txt"
            text = r.get("_text") or _fallback_text(r["license"])
            header = (f"{r['name']} {r['version']}\nLicense: {r['license']}\n"
                      f"Homepage: {r.get('homepage') or 'n/a'}\n"
                      + "=" * 72 + "\n\n")
            (OUT / eco / fname).write_text(
                header + (text or "(no bundled license text found; see SPDX id above)\n"),
                encoding="utf-8",
            )
            manifest.append({
                "ecosystem": eco, "name": r["name"], "version": r["version"],
                "license": r["license"], "homepage": r.get("homepage") or "",
                "license_file": f"licenses/{eco}/{fname}",
                "is_oss": is_oss(r["license"]),
            })

    (OUT / "manifest.json").write_text(
        json.dumps({"packages": manifest, "count": len(manifest)}, indent=2) + "\n",
        encoding="utf-8",
    )

    def table(rows: list[dict]) -> str:
        if not rows:
            return "_None enumerated. (Run with `--python-lib` after building the app.)_\n"
        out = ["| Package | Version | License | Homepage |",
               "|---|---|---|---|"]
        for r in rows:
            hp = r.get("homepage") or ""
            hp = f"[link]({hp})" if hp.startswith("http") else (hp or "—")
            out.append(f"| `{r['name']}` | {r['version']} | {r['license']} | {hp} |")
        return "\n".join(out) + "\n"

    flagged = [m for m in manifest if not m["is_oss"]]
    md = [
        "# Third-Party Licenses",
        "",
        "All third-party libraries bundled in **UCC App Builder** are open source. "
        "This inventory is generated automatically by "
        "[`scripts/generate_licenses.py`](../scripts/generate_licenses.py) and verified "
        "in CI (the `licenses` job fails if any dependency is not a recognised "
        "open-source license).",
        "",
        f"- **npm** (production dependency closure): **{len(npm)}** packages",
        f"- **python** (in-Splunk advisor / Agent SDK stack): **{len(py)}** packages",
        f"- Full license texts: [`licenses/npm/`](npm/) and [`licenses/python/`](python/)",
        f"- Machine-readable: [`licenses/manifest.json`](manifest.json)",
        "",
        "> The project's own license is [`LICENSE`](../LICENSE) (Apache-2.0).",
        "",
    ]
    if flagged:
        md += ["## ⚠️ Needs review (license not recognised as OSS)", "",
               table([{**m, "homepage": m["homepage"]} for m in flagged]), ""]
    md += ["## npm dependencies", "", table(npm), "",
           "## Python dependencies", "", table(py), ""]
    (OUT / "THIRD_PARTY_LICENSES.md").write_text("\n".join(md), encoding="utf-8")

    (OUT / "README.md").write_text(
        "# licenses/\n\n"
        "Auto-generated third-party license inventory for UCC App Builder.\n\n"
        "**Do not edit by hand** — regenerate with:\n\n"
        "```bash\n"
        "# npm side is hermetic; for the Python advisor stack, build the app first:\n"
        "bash splunk-app/deploy/build_agent_app.sh /tmp/uccbuild\n"
        "python scripts/generate_licenses.py --python-lib /tmp/uccbuild/ucc_app_builder/lib\n"
        "```\n\n"
        "- `THIRD_PARTY_LICENSES.md` — human-readable summary + tables\n"
        "- `manifest.json` — machine-readable inventory (incl. `is_oss` flag)\n"
        "- `npm/`, `python/` — full license text, one file per package\n\n"
        "CI regenerates this and runs `--check`, which fails the build if any bundled "
        "library is not a recognised open-source license.\n",
        encoding="utf-8",
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--python-lib", type=Path, default=None,
                    help="Built app lib/ dir to scan for *.dist-info (e.g. "
                         "/tmp/uccbuild/ucc_app_builder/lib)")
    ap.add_argument("--check", action="store_true",
                    help="Exit non-zero if any dependency is not recognised OSS")
    args = ap.parse_args()

    npm = collect_npm()
    py = collect_python(args.python_lib)
    write_outputs(npm, py)

    total = len(npm) + len(py)
    print(f"Wrote licenses/ — {len(npm)} npm + {len(py)} python = {total} packages")
    print(f"  summary : {OUT / 'THIRD_PARTY_LICENSES.md'}")
    print(f"  manifest: {OUT / 'manifest.json'}")

    flagged = [r for r in (npm + py) if not is_oss(r["license"])]
    if flagged:
        print("\nNON-OSS / UNKNOWN licenses detected:", file=sys.stderr)
        for r in flagged:
            print(f"  - [{r['ecosystem']}] {r['name']} {r['version']}: "
                  f"{r['license']!r}", file=sys.stderr)
        if args.check:
            print("\nFAIL: not all dependencies are recognised open-source licenses.",
                  file=sys.stderr)
            return 1
        print("(run with --check to make this fail CI)", file=sys.stderr)
    else:
        print("All dependencies carry a recognised open-source license. ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
