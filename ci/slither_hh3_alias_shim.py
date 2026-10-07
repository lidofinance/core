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
5.2.0) onto one path. It also maps @aragon/os 4.2.0, which is nested under
`node_modules/@aragon/apps-*/node_modules/`, onto the files of @aragon/os 4.4.0.

The upstream fix is https://github.com/crytic/crytic-compile/pull/706.

What this does
--------------
Wraps `process_hardhat_v3_filename` so that for an `npm/<pkg>@<version>/<rest>` source
it returns `<install_dir>/<rest>`, with `<install_dir>` relative to node_modules (e.g.
`@openzeppelin/contracts-v5.2/access/IAccessControl.sol`). Hardhat writes each import
that it resolved as a solc remapping in the build-info, e.g.
`project/:@openzeppelin/contracts-v5.2/=npm/@openzeppelin/contracts@5.2.0/`. The shim
finds the remapping prefix from the importer's directory, as Node.js does, so nested
packages resolve too. If no remapping resolves the package, it falls back to the
unmodified upstream function.

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

Remove this shim (and go back to `slither .`) once a crytic-compile release includes
the upstream fix.
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

# Package root in a Hardhat 3 source name: npm/<pkg>@<version>/
_HH3_NPM_PACKAGE = re.compile(r"npm/(?:@[^/]+/)?[^/@]+@[^/]+/")

_BUILD_INFO_DIR = Path("artifacts", "build-info")

# project/<rest> -- Hardhat 3 prefixes every local project source (contracts/, test/,
# scripts/, ...) with "project/". Upstream only strips "project/contracts/", so paths
# like "project/test/.../WstETH__Harness.sol" are left unresolved. The prefix always
# denotes the project root, so stripping it generally is correct (and subsumes the
# upstream contracts-only case).
_HH3_PROJECT = re.compile(r"project/(.+)")


def _node_modules_lookup(package: str, directory: Path) -> Path | None:
    """Find a package as Node.js does: in node_modules of the directory, then of each
    parent directory."""
    for parent in (directory, *directory.parents):
        candidate = parent / "node_modules" / package
        if candidate.is_dir():
            return candidate
    return None


@lru_cache(maxsize=1)
def _package_dirs() -> dict[str, str]:
    """npm/<pkg>@<version>/ -> install dir relative to node_modules.

    The source is the remappings of all build-info files. Each remapping is
    <context>:<prefix>=npm/<pkg>@<version>/. The context is `project/` or another
    npm/<pkg>@<version>/, so repeat until a pass finds no new package. The order of
    files and remappings is fixed, so a package installed twice always resolves to the
    same directory.
    """
    imports = []
    for build_info in sorted(_BUILD_INFO_DIR.glob("*.json")):
        if build_info.name.endswith(".output.json"):
            continue
        loaded = json.loads(build_info.read_text(encoding="utf-8"))
        settings = loaded["input"]["settings"]
        for remapping in settings.get("remappings", []):
            context_and_prefix, _, target = remapping.partition("=")
            context, _, prefix = context_and_prefix.rpartition(":")
            if _HH3_NPM_PACKAGE.fullmatch(target):
                imports.append((target, context, prefix.rstrip("/")))

    root = Path.cwd()
    dirs: dict[str, Path] = {}
    found = True
    while found:
        found = False
        for target, context, prefix in imports:
            if target in dirs:
                continue
            if _HH3_NPM_PACKAGE.fullmatch(context):
                if context not in dirs:
                    continue
                base = dirs[context]
            else:
                base = root
            package_dir = _node_modules_lookup(prefix, base)
            if package_dir is not None:
                dirs[target] = package_dir
                found = True

    node_modules = root / "node_modules"
    return {
        target: path.relative_to(node_modules).as_posix()
        for target, path in dirs.items()
    }


def _patched_process_hardhat_v3_filename(filename: str) -> str:
    npm = _HH3_NPM_PACKAGE.match(filename)
    if npm:
        install_dir = _package_dirs().get(npm.group(0))
        if install_dir is not None:
            return f"{install_dir}/{filename[npm.end():]}"
        # No remapping resolves this package -- let upstream strip the version.
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
