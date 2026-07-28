#!/usr/bin/env python3
"""Run Slither with a crytic-compile shim for Hardhat 3 + yarn version-aliased deps.

Background
----------
crytic-compile >=0.4.0 added Hardhat 3 support, which fixed the `KeyError: 'output'`
crash on HH3's split build-info. But its HH3 npm-path normalizer
(`crytic_compile.utils.naming.process_hardhat_v3_filename`) turns a build-info source
name like

    npm/@openzeppelin/contracts@5.2.0/access/IAccessControl.sol

into

    @openzeppelin/contracts/access/IAccessControl.sol

by *stripping the version*. It then looks for that file under
`node_modules/@openzeppelin/contracts/` -- which in this repo is OZ 3.4.0 and does
not contain `access/IAccessControl.sol`. That file lives under the yarn *alias*
directory `node_modules/@openzeppelin/contracts-v5.2/` (`@openzeppelin/contracts-v5.2`
is `npm:@openzeppelin/contracts@5.2.0`). Result: `InvalidCompilation: Unknown file`.
Stripping the version also collapses this repo's three OZ versions (3.4.0 / 4.4.1 /
5.2.0) onto one path.

There is no released or unreleased crytic-compile (checked dev + master) that resolves
version-aliased npm packages, so we patch it at runtime here.

What this does
--------------
Wraps `process_hardhat_v3_filename` so that for an `npm/<pkg>@<version>/<rest>` source
it resolves <pkg>@<version> to the actual install directory in node_modules by matching
each candidate's package.json `name` + `version`, and returns `<install_dir>/<rest>`
(e.g. `@openzeppelin/contracts-v5.2/access/IAccessControl.sol`). That path exists on
disk and keeps each OZ version distinct. If no exact name+version match is found, it
falls back to the unmodified upstream function -- so behaviour is identical to stock
crytic-compile except when we can positively resolve an aliased dependency.

It also generalizes upstream's `project/contracts/...` handling to any `project/...`
path (HH3 prefixes every local project source -- contracts/, test/, scripts/ -- with
`project/`, but upstream only strips the contracts/ case, leaving e.g. compiled test
harnesses under test/ unresolved).

The same normalization is applied in two places so both sides agree:
1. `process_hardhat_v3_filename` (naming + hardhat modules) -- used when crytic-compile
   registers source units during compilation (sets Filename.used).
2. `CompilationUnit.filename_lookup` -- used when Slither resolves AST import directives
   by their raw HH3 name; upstream reimplements the normalization inline (version-strip,
   no alias), so we override it with the alias-aware version.

Remove this shim (and go back to `slither .`) once crytic-compile handles aliased /
multi-version npm dependencies upstream.
"""

import json
import re
import sys
from functools import lru_cache
from pathlib import Path

import crytic_compile.compilation_unit as _compilation_unit
import crytic_compile.platform.hardhat as _hardhat
import crytic_compile.utils.naming as _naming

_orig = getattr(_naming, "process_hardhat_v3_filename", None)
if _orig is None:
    sys.exit(
        "slither_hh3_alias_shim: installed crytic-compile has no Hardhat 3 support "
        "(process_hardhat_v3_filename missing); expected crytic-compile >=0.4.0."
    )

# npm/<pkg>@<version>/<rest> -- <pkg> captured non-greedily so the version '@' is the
# one immediately before the trailing '/<rest>' (works for scoped names like
# @openzeppelin/contracts).
_HH3_NPM = re.compile(r"npm/(.+?)@([^/]+)/(.+)")

# project/<rest> -- Hardhat 3 prefixes every local project source (contracts/, test/,
# scripts/, ...) with "project/". Upstream only strips "project/contracts/", so paths
# like "project/test/.../WstETH__Harness.sol" are left unresolved. The prefix always
# denotes the project root, so stripping it generally is correct (and subsumes the
# upstream contracts-only case).
_HH3_PROJECT = re.compile(r"project/(.+)")


@lru_cache(maxsize=1)
def _node_modules() -> Path | None:
    """First node_modules found walking up from the working directory."""
    cwd = Path.cwd()
    for directory in (cwd, *cwd.parents):
        candidate = directory / "node_modules"
        if candidate.is_dir():
            return candidate
    return None


def _pkg_identity(pkg_dir: Path) -> tuple[str | None, str | None]:
    try:
        data = json.loads((pkg_dir / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, None
    return data.get("name"), data.get("version")


@lru_cache(maxsize=None)
def _resolve_install_dir(package: str, version: str) -> str | None:
    """node_modules-relative install dir for <package>@<version>, or None.

    Handles yarn/npm aliases where a package is installed under a directory name that
    differs from its declared name (e.g. `@openzeppelin/contracts-v5.2`).
    """
    node_modules = _node_modules()
    if node_modules is None:
        return None

    # Fast path: the canonical install location (covers every non-aliased dependency).
    canonical = node_modules.joinpath(*package.split("/"))
    name, ver = _pkg_identity(canonical)
    if name == package and ver == version:
        return package

    # Aliased: scan the package's scope dir (scoped) or node_modules root (unscoped)
    # for a sibling whose package.json declares this exact name + version.
    if package.startswith("@") and "/" in package:
        search_root = node_modules / package.split("/", 1)[0]
    else:
        search_root = node_modules
    if search_root.is_dir():
        for candidate in search_root.iterdir():
            if not candidate.is_dir():
                continue
            name, ver = _pkg_identity(candidate)
            if name == package and ver == version:
                return candidate.relative_to(node_modules).as_posix()
    return None


def _patched_process_hardhat_v3_filename(filename: str) -> str:
    npm = _HH3_NPM.match(filename)
    if npm:
        install_dir = _resolve_install_dir(npm.group(1), npm.group(2))
        if install_dir is not None:
            return f"{install_dir}/{npm.group(3)}"
        # Version not installed under a matching dir -- let upstream strip the version.
        return _orig(filename)

    project = _HH3_PROJECT.match(filename)
    if project:
        return project.group(1)

    return _orig(filename)


# Patch both bindings: naming.py (source of truth) and hardhat.py (which imported the
# function by name via `from ... import process_hardhat_v3_filename`). This fixes source
# registration during compilation (Filename.used becomes the alias-resolved name).
_naming.process_hardhat_v3_filename = _patched_process_hardhat_v3_filename
_hardhat.process_hardhat_v3_filename = _patched_process_hardhat_v3_filename


# Slither resolves AST import directives via CompilationUnit.filename_lookup, which does
# NOT call process_hardhat_v3_filename -- it reimplements the HH3 normalization inline
# (upstream: strips the version, no alias resolution). Since compilation registered the
# source units under alias-resolved names, we must normalize the lookup query with the
# SAME logic, otherwise e.g. `npm/@openzeppelin/contracts@5.2.0/...` normalizes to the
# bare `@openzeppelin/contracts/...` and matches nothing (or, worse, a different OZ
# version that shares the path). We normalize first, then delegate to the original for
# the actual dict lookup (our output has no npm/ or project/ prefix, so the original's
# inline regex is a no-op on it).
_orig_filename_lookup = _compilation_unit.CompilationUnit.filename_lookup


def _patched_filename_lookup(self, filename: str):
    from crytic_compile.platform.hardhat import Hardhat

    if isinstance(self.crytic_compile.platform, Hardhat):
        filename = _patched_process_hardhat_v3_filename(filename)
    return _orig_filename_lookup(self, filename)


_compilation_unit.CompilationUnit.filename_lookup = _patched_filename_lookup


if __name__ == "__main__":
    # Delegate to Slither's CLI entry point; it reads sys.argv, so the args passed to
    # this script (".", "--no-fail-pedantic", ...) are consumed exactly as by `slither`.
    from slither.__main__ import main

    main()
