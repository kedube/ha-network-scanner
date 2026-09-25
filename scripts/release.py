#!/usr/bin/env python3
"""Work out the next release from git history: whether to release, the version, and the notes.

The release job in .github/workflows/ci.yaml runs this after every check on a
push to main has passed. It also runs locally, to preview the next release:

    python scripts/release.py

Rules
  * Only changes to what HACS installs (custom_components/ or hacs.json) cause
    a release. Docs, test and CI changes go out with the next one.
  * Versions are major.minor, and each release counts up by one tenth:
    2.3, 2.4, ... 2.9, 3.0. A breaking change skips ahead to the next major
    (2.4 to 3.0): "BREAKING CHANGE" in a message, or "!" after a Conventional
    Commits type ("feat!: drop the old YAML options"). Tags from before this
    scheme, such as 2.2.1, still count as the last release.
  * Each commit lands in a section of the release notes. A commit that
    changes nothing HACS installs is left out, whatever its message says. For
    the rest, a Conventional Commits type decides when there is one (feat and
    perf are enhancements, fix is a fix, docs/test/ci/build/chore/style/
    refactor are left out). Otherwise the subject's words do: "Add ...",
    "Improve ...", "Performance ...", "... enhancements" are enhancements;
    "Fix ...", "Restore ...", "Correct ..." are fixes. Bulleted lines in a
    commit body become sub-points under that commit in the notes.
  * The version never goes backwards or repeats: it counts up from the higher
    of the last tag and the manifest version released with it, and a version
    raised by hand in manifest.json since then wins if it is higher.

Only the standard library is used, so the job needs no dependencies.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

MANIFEST = "custom_components/network_scanner/manifest.json"
SHIPPED_PREFIXES = ("custom_components/", "hacs.json")
DEFAULT_REPOSITORY = "kedube/ha-network-scanner"

BREAKING = "breaking"
ENHANCEMENT = "enhancement"
FIX = "fix"
OTHER = "other"
MAINTENANCE = "maintenance"  # never listed in the notes

SECTIONS = (
    (BREAKING, "⚠️ Breaking changes"),
    (ENHANCEMENT, "✨ Enhancements"),
    (FIX, "🐛 Fixes"),
    (OTHER, "🔧 Other changes"),
)

LEVELS = ("minor", "major")

# (major, minor, patch). Only versions from before the major.minor scheme
# have a patch; it orders them, and new versions leave it out.
Version = tuple[int, int, int]

_VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)(?:\.(\d+))?$")
_CONVENTIONAL_RE = re.compile(
    r"^(?P<type>[a-zA-Z]+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?:\s*(?P<text>.+)$"
)
_PR_MERGE_RE = re.compile(r"^Merge pull request #(?P<number>\d+) from \S+")
_OTHER_MERGE_RE = re.compile(r"^Merge (branch|remote-tracking branch|tag) ")
_RELEASE_RE = re.compile(r"^Release v?\d+\.\d+(\.\d+)?$")
_BULLET_RE = re.compile(r"^\s*[-*•]\s+(?P<text>\S.*)$")
_BREAKING_RE = re.compile(r"\bBREAKING[ -]CHANGES?\b")

_TYPE_CATEGORIES = {
    "feat": ENHANCEMENT,
    "feature": ENHANCEMENT,
    "perf": ENHANCEMENT,
    "fix": FIX,
    "revert": OTHER,
    **dict.fromkeys(
        ("docs", "doc", "test", "tests", "ci", "build", "chore", "style", "refactor", "deps"),
        MAINTENANCE,
    ),
}
_ENHANCEMENT_WORDS = re.compile(
    r"\b(add(s|ed|ing)?|new|support(s|ed|ing)?|introduc\w*|implement\w*|enhanc\w*|"
    r"improv\w*|optimi[sz]\w*|performance|faster|allow\w*|features?)\b",
    re.IGNORECASE,
)
_FIX_WORDS = re.compile(
    r"\b(fix(es|ed|ing)?|bugs?|bugfix\w*|restor\w*|correct\w*|resolv\w*|repair\w*|"
    r"prevent\w*|crash\w*|regressions?)\b",
    re.IGNORECASE,
)
_MAINTENANCE_START = re.compile(r"^(bump|ci|tests?|lint|readme|docs?)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Commit:
    sha: str
    subject: str
    body: str = ""
    # Files the commit changed; None when unknown.
    paths: tuple[str, ...] | None = None


def is_shipped(path: str) -> bool:
    return path.startswith(SHIPPED_PREFIXES)


@dataclass(frozen=True)
class Change:
    category: str
    text: str
    details: tuple[str, ...] = ()
    breaking: bool = False


@dataclass(frozen=True)
class Plan:
    release: bool
    reason: str
    version: str | None = None
    level: str | None = None
    notes: str = ""


# ---------------------------------------------------------------- versions


def parse_version(text: str | None) -> Version | None:
    match = _VERSION_RE.match((text or "").strip())
    return (int(match[1]), int(match[2]), int(match[3] or 0)) if match else None


def format_version(version: Version) -> str:
    major, minor, _ = version
    return f"{major}.{minor}"


def bump(version: Version, level: str) -> Version:
    major, minor, _ = version
    if level == "major" or (level == "minor" and minor >= 9):
        return (major + 1, 0, 0)
    if level == "minor":
        return (major, minor + 1, 0)
    raise ValueError(f"Unknown bump level {level!r}")


def latest_tag(tags: Iterable[str]) -> str | None:
    versions = [(parse_version(tag), tag) for tag in tags]
    released = [(version, tag) for version, tag in versions if version]
    return max(released)[1] if released else None


# ---------------------------------------------------------------- commits


def _sentence(text: str) -> str:
    text = text.strip().rstrip(".")
    return text[:1].upper() + text[1:]


def _category_from_words(text: str) -> str:
    first = re.match(r"\W*(\w+)", text)
    word = first[1] if first else ""
    if _FIX_WORDS.fullmatch(word):
        return FIX
    if _ENHANCEMENT_WORDS.fullmatch(word):
        return ENHANCEMENT
    if _MAINTENANCE_START.match(text):
        return MAINTENANCE
    if _ENHANCEMENT_WORDS.search(text):
        return ENHANCEMENT
    if _FIX_WORDS.search(text):
        return FIX
    return OTHER


def classify(commit: Commit) -> Change | None:
    """Turn a commit into a release-notes entry, or None if it isn't one."""
    subject = commit.subject.strip()
    body_lines = commit.body.splitlines()

    if _RELEASE_RE.match(subject) or _OTHER_MERGE_RE.match(subject):
        return None

    suffix = ""
    if pr := _PR_MERGE_RE.match(subject):
        # A merged pull request: its title is the first line of the body.
        title_index = next((i for i, line in enumerate(body_lines) if line.strip()), None)
        if title_index is None:
            return None
        subject = body_lines[title_index].strip()
        body_lines = body_lines[title_index + 1 :]
        suffix = f" (#{pr['number']})"

    breaking = bool(_BREAKING_RE.search(commit.subject) or _BREAKING_RE.search(commit.body))
    if conventional := _CONVENTIONAL_RE.match(subject):
        category = _TYPE_CATEGORIES.get(conventional["type"].lower(), OTHER)
        breaking = breaking or bool(conventional["bang"])
        text = _sentence(conventional["text"])
        if scope := conventional["scope"]:
            text = f"**{scope}:** {text}"
    else:
        category = _category_from_words(subject)
        text = _sentence(subject)

    if commit.paths is not None and not any(is_shipped(path) for path in commit.paths):
        # Docs, tests, CI: nothing a HACS user gets, however it is worded.
        category = MAINTENANCE

    details = tuple(
        _sentence(match["text"])
        for line in body_lines
        if (match := _BULLET_RE.match(line)) and not _BREAKING_RE.search(line)
    )
    return Change(category, text + suffix, details, breaking)


def bump_level(changes: Sequence[Change]) -> str:
    return "major" if any(change.breaking for change in changes) else "minor"


# ---------------------------------------------------------------- notes


def render_notes(
    changes: Sequence[Change], version: str, previous: str | None, repository: str
) -> str:
    """Markdown for the GitHub release, which HACS also shows before an update."""
    by_section: dict[str, list[Change]] = {key: [] for key, _ in SECTIONS}
    for change in changes:
        if change.breaking:
            by_section[BREAKING].append(change)
        elif change.category != MAINTENANCE:
            by_section[change.category].append(change)

    lines: list[str] = []
    for key, heading in SECTIONS:
        if not by_section[key]:
            continue
        lines += [f"### {heading}", ""]
        for change in by_section[key]:
            lines.append(f"- {change.text}")
            lines += [f"  - {detail}" for detail in change.details]
        lines.append("")

    if not lines:
        lines = ["Maintenance release with no user-facing changes.", ""]
    if previous:
        lines.append(
            f"**Full changelog**: https://github.com/{repository}/compare/{previous}...{version}"
        )
    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------- planning


def make_plan(
    *,
    commits: Sequence[Commit],
    changed_paths: Iterable[str],
    last_tag: str | None,
    released_manifest_version: str | None,
    head_manifest_version: str | None,
    repository: str = DEFAULT_REPOSITORY,
    forced_level: str | None = None,
) -> Plan:
    """Decide whether and how to release. commits are oldest first."""
    if not commits:
        return Plan(False, f"No commits since {last_tag or 'the start'}.")
    shipped = sorted(p for p in changed_paths if is_shipped(p))
    if not shipped and forced_level is None:
        return Plan(False, f"Nothing HACS installs has changed since {last_tag}.")

    changes = [change for commit in commits if (change := classify(commit))]
    level = forced_level or bump_level(changes)
    head = parse_version(head_manifest_version)

    if last_tag is None:
        # First release: take the manifest as it stands.
        if head is None:
            raise ValueError(f"No release tags and no valid version in {MANIFEST}")
        version = head
    else:
        base = max(v for v in (parse_version(last_tag), parse_version(released_manifest_version)) if v)
        version = max(bump(base, level), head or (0, 0, 0))

    tag = format_version(version)
    return Plan(
        True,
        f"{len(shipped)} shipped file(s) changed since {last_tag}." if last_tag else "First release.",
        tag,
        level,
        render_notes(changes, tag, last_tag, repository),
    )


# ---------------------------------------------------------------- git


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout


def read_commits(revision_range: str) -> list[Commit]:
    """First-parent history, oldest first, with the files each commit changed.

    Following first parents makes a merged pull request one entry, and its
    files are everything the pull request changed.
    """
    raw = git(
        "log",
        "--first-parent",
        "--reverse",
        "--diff-merges=first-parent",
        "--name-only",
        "--format=%x1e%H%x1f%s%x1f%b%x1d",
        revision_range,
    )
    commits = []
    for record in raw.split("\x1e"):
        if not record.strip():
            continue
        header, files = record.split("\x1d", 1)
        sha, subject, body = header.split("\x1f", 2)
        paths = tuple(line for line in files.splitlines() if line)
        commits.append(Commit(sha, subject, body.strip("\n"), paths))
    return commits


def manifest_version_at(revision: str) -> str | None:
    try:
        return json.loads(git("show", f"{revision}:{MANIFEST}")).get("version")
    except (subprocess.CalledProcessError, ValueError):
        return None


def set_manifest_version(path: Path, version: str) -> None:
    """Rewrite only the version string, so the rest of the file keeps its layout."""
    text = path.read_text()
    updated, count = re.subn(r'("version"\s*:\s*")[^"]*(")', rf"\g<1>{version}\g<2>", text)
    if count != 1:
        raise ValueError(f"Expected one version field in {path}, found {count}")
    path.write_text(updated)


def _write_github_file(variable: str, text: str) -> None:
    if path := os.environ.get(variable):
        with open(path, "a", encoding="utf-8") as file:
            file.write(text)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--bump",
        choices=("auto", *LEVELS),
        default="auto",
        help="auto works it out from the commits; any other value also forces a release",
    )
    parser.add_argument("--notes-file", type=Path, help="write the release notes here")
    parser.add_argument(
        "--write-manifest", action="store_true", help="set the new version in manifest.json"
    )
    parser.add_argument(
        "--repository",
        default=os.environ.get("GITHUB_REPOSITORY", DEFAULT_REPOSITORY),
        help="owner/name, for the changelog link",
    )
    args = parser.parse_args(argv)

    root = Path(git("rev-parse", "--show-toplevel").strip())
    last_tag = latest_tag(git("tag", "--list").splitlines())
    if last_tag:
        commits = read_commits(f"{last_tag}..HEAD")
        changed = git("diff", "--name-only", last_tag, "HEAD").splitlines()
    else:
        commits = read_commits("HEAD")
        changed = git("ls-files").splitlines()

    plan = make_plan(
        commits=commits,
        changed_paths=changed,
        last_tag=last_tag,
        released_manifest_version=manifest_version_at(last_tag) if last_tag else None,
        head_manifest_version=json.loads((root / MANIFEST).read_text()).get("version"),
        repository=args.repository,
        forced_level=None if args.bump == "auto" else args.bump,
    )

    if plan.release:
        print(f"Release {plan.version} ({plan.level} bump from {last_tag or 'nothing'}): {plan.reason}\n")
        print(plan.notes)
        if args.notes_file:
            args.notes_file.write_text(plan.notes, encoding="utf-8")
        if args.write_manifest:
            set_manifest_version(root / MANIFEST, plan.version)
        summary = f"## Next release: {plan.version}\n\n{plan.reason}\n\n{plan.notes}"
    else:
        print(f"No release: {plan.reason}")
        summary = f"## No release\n\n{plan.reason}\n"

    _write_github_file(
        "GITHUB_OUTPUT",
        f"release={'true' if plan.release else 'false'}\n"
        f"version={plan.version or ''}\nlevel={plan.level or ''}\n",
    )
    _write_github_file("GITHUB_STEP_SUMMARY", summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
