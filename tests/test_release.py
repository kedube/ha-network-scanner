"""Tests for scripts/release.py, which versions and describes each release."""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

# scripts/ is not a package; load the script by path. Dataclasses need the
# module registered in sys.modules while it executes.
_SPEC = importlib.util.spec_from_file_location(
    "release", Path(__file__).parents[1] / "scripts" / "release.py"
)
release = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = release
_SPEC.loader.exec_module(release)

Commit = release.Commit
SHIPPED = ["custom_components/network_scanner/sensor.py"]


def plan(*subjects: str, changed=SHIPPED, last_tag="1.3.0", released="1.3.0", head="1.3.0", **kwargs):
    commits = [
        Commit(f"sha{i}", *subject) if isinstance(subject, tuple) else Commit(f"sha{i}", subject)
        for i, subject in enumerate(subjects)
    ]
    return release.make_plan(
        commits=commits,
        changed_paths=changed,
        last_tag=last_tag,
        released_manifest_version=released,
        head_manifest_version=head,
        **kwargs,
    )


# ---------------------------------------------------------------- classification


@pytest.mark.parametrize(
    ("subject", "category"),
    [
        # This repository's own free-form history.
        ("Adding Network Scanner card", release.ENHANCEMENT),
        ("Performance improvements", release.ENHANCEMENT),
        ("Numerous fixes and enhancements", release.ENHANCEMENT),
        ("Restore configuration.yaml pre-fill for the Add Integration form", release.FIX),
        ("Fix native_value never surfacing as sensor state", release.FIX),
        ("Fix crash when adding a device", release.FIX),
        ("Modify nmap scan arguments for network discovery", release.OTHER),
        ("Bump jsdom from 30.1.1 to 30.2.0", release.MAINTENANCE),
        ("Update README", release.OTHER),
        # Conventional Commits.
        ("feat: add a vendor filter", release.ENHANCEMENT),
        ("perf: scan in parallel", release.ENHANCEMENT),
        ("fix(card): keep rows open across scans", release.FIX),
        ("docs: explain HACS install", release.MAINTENANCE),
        ("ci: cache pip", release.MAINTENANCE),
        ("test: cover migration", release.MAINTENANCE),
        ("refactor: split scanner", release.MAINTENANCE),
    ],
)
def test_classify(subject: str, category: str) -> None:
    assert release.classify(Commit("sha", subject)).category == category


def test_classify_cleans_up_text() -> None:
    change = release.classify(Commit("sha", "feat(card): show hostnames."))
    assert change.text == "**card:** Show hostnames"


def test_classify_pull_request_merge_uses_its_title() -> None:
    change = release.classify(
        Commit("sha", "Merge pull request #7 from someone/branch", "\nAdd IPv6 support\n\n- Scans /64s\n")
    )
    assert change == release.Change(release.ENHANCEMENT, "Add IPv6 support (#7)", ("Scans /64s",))


@pytest.mark.parametrize(
    "commit",
    [
        Commit("sha", "Release 2.1.0"),
        Commit("sha", "Release 2.3"),
        Commit("sha", "Merge branch 'main' of github.com:kedube/ha-network-scanner"),
        Commit("sha", "Merge pull request #3 from someone/branch", ""),
    ],
)
def test_classify_skips_bookkeeping_commits(commit: Commit) -> None:
    assert release.classify(commit) is None


def test_body_bullets_become_details() -> None:
    change = release.classify(
        Commit(
            "sha",
            "Numerous fixes and enhancements",
            "Some context that is not a list.\n\n- faster reverse DNS\n* sensor state shows the count\n",
        )
    )
    assert change.details == ("Faster reverse DNS", "Sensor state shows the count")


def test_commits_that_ship_nothing_are_left_out() -> None:
    """Judged by the files touched, not the wording: users never see a README change."""
    readme = release.classify(Commit("sha", "Add HACS steps to the README", paths=("README.md",)))
    assert readme.category == release.MAINTENANCE
    card = release.classify(
        Commit("sha", "Add HACS steps to the card", paths=("README.md", "hacs.json"))
    )
    assert card.category == release.ENHANCEMENT
    # An explicit breaking change is always announced.
    assert release.classify(
        Commit("sha", "Rename options", "BREAKING CHANGE: see README", paths=("README.md",))
    ).breaking


@pytest.mark.parametrize(
    "commit",
    [
        Commit("sha", "feat!: drop YAML options"),
        Commit("sha", "Rework config entries", "BREAKING CHANGE: re-add the integration"),
    ],
)
def test_breaking_changes(commit: Commit) -> None:
    assert release.classify(commit).breaking


# ---------------------------------------------------------------- versions


@pytest.mark.parametrize(
    ("subjects", "level", "version"),
    [
        (["Fix a crash"], "minor", "1.4"),
        (["Fix a crash", "Add a card"], "minor", "1.4"),
        (["Fix a crash", ("Rework entries", "BREAKING CHANGE: re-add it")], "major", "2.0"),
        (["refactor: tidy the scanner"], "minor", "1.4"),
    ],
)
def test_bump_level_follows_the_biggest_change(subjects, level: str, version: str) -> None:
    result = plan(*subjects)
    assert (result.release, result.level, result.version) == (True, level, version)


@pytest.mark.parametrize(
    ("last", "level", "expected"),
    [
        # From the last major.minor.patch release to the major.minor scheme.
        ("2.2.1", "minor", "2.3"),
        ("2.3", "minor", "2.4"),
        ("2.9", "minor", "3.0"),
        ("3.9", "minor", "4.0"),
        ("2.9.5", "minor", "3.0"),
        ("2.3", "major", "3.0"),
        ("2.9", "major", "3.0"),
    ],
)
def test_counts_up_by_tenths(last: str, level: str, expected: str) -> None:
    release_version = release.bump(release.parse_version(last), level)
    assert release.format_version(release_version) == expected


def test_counts_up_from_the_manifest_that_was_released() -> None:
    """Tag 1.3.0 shipped manifest 2.0.0; the next release must not reuse 2.0."""
    assert plan("Adding Network Scanner card", released="2.0.0", head="2.0.0").version == "2.1"


def test_keeps_a_version_raised_by_hand() -> None:
    assert plan("Fix a crash", head="3.0").version == "3.0"
    # ...but not one below what the commits call for.
    assert plan("Add a card", head="1.3.1").version == "1.4"


def test_first_release_uses_the_manifest() -> None:
    result = plan("Add everything", last_tag=None, released=None, head="0.1")
    assert (result.release, result.version) == (True, "0.1")
    assert "Full changelog" not in result.notes


def test_no_release_without_shipped_changes() -> None:
    result = plan("docs: README", changed=["README.md", "tests/test_init.py", ".github/workflows/ci.yaml"])
    assert not result.release
    assert "Nothing HACS installs" in result.reason


def test_hacs_json_counts_as_shipped() -> None:
    assert plan("Raise the minimum Home Assistant version", changed=["hacs.json"]).release


def test_no_release_without_commits() -> None:
    assert not plan().release


def test_forced_level_releases_anyway() -> None:
    result = plan("docs: README", changed=["README.md"], forced_level="minor")
    assert (result.release, result.version) == (True, "1.4")


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        (["1.2.0", "1.10.0", "1.3.0", "not-a-version"], "1.10.0"),
        (["v2.0.0", "1.9.9"], "v2.0.0"),
        # Both schemes side by side.
        (["2.2.1", "2.3", "2.2.0"], "2.3"),
        (["2.2.1", "2.2"], "2.2.1"),
        ([], None),
    ],
)
def test_latest_tag(tags: list[str], expected: str | None) -> None:
    assert release.latest_tag(tags) == expected


# ---------------------------------------------------------------- notes


def test_release_notes() -> None:
    result = plan(
        ("Rework config entries", "BREAKING CHANGE: re-add the integration"),
        ("Adding Network Scanner card", "- Search and filter\n- Scan now button"),
        "Fix native_value never surfacing as sensor state",
        "Modify nmap scan arguments",
        "ci: add release job",
    )
    assert result.notes == (
        "### ⚠️ Breaking changes\n\n"
        "- Rework config entries\n\n"
        "### ✨ Enhancements\n\n"
        "- Adding Network Scanner card\n"
        "  - Search and filter\n"
        "  - Scan now button\n\n"
        "### 🐛 Fixes\n\n"
        "- Fix native_value never surfacing as sensor state\n\n"
        "### 🔧 Other changes\n\n"
        "- Modify nmap scan arguments\n\n"
        "**Full changelog**: https://github.com/kedube/ha-network-scanner/compare/1.3.0...2.0\n"
    )


def test_release_notes_for_maintenance_only() -> None:
    result = plan("refactor: split scanner")
    assert result.notes.startswith("Maintenance release with no user-facing changes.")


# ---------------------------------------------------------------- end to end


def run_git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


def commit_file(repo: Path, path: str, content: str, message: str) -> None:
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    run_git(repo, "add", path)
    run_git(repo, "commit", "-m", message)


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A git repository with one release, 1.0.0, whose manifest has a different layout than json.dumps."""
    run_git(tmp_path, "init", "-q", "-b", "main")
    manifest = '{\n  "domain": "network_scanner",\n  "dependencies": ["frontend", "http"],\n  "version": "1.0.0"\n}\n'
    commit_file(tmp_path, release.MANIFEST, manifest, "Initial release")
    run_git(tmp_path, "tag", "1.0.0")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    return tmp_path


def test_main_end_to_end(repo: Path, tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    out = tmp_path_factory.mktemp("out")
    monkeypatch.setenv("GITHUB_OUTPUT", str(out / "output"))
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(out / "summary"))
    commit_file(repo, "custom_components/network_scanner/sensor.py", "x = 1\n", "Add a last_scan attribute")
    commit_file(repo, "README.md", "docs\n", "Update README with HACS steps")
    # A pull request whose branch commits are noise; only its title should show.
    run_git(repo, "switch", "-q", "-c", "card-fix")
    commit_file(repo, "custom_components/network_scanner/frontend/my card.js", "x\n", "wip")
    commit_file(repo, "custom_components/network_scanner/frontend/my card.js", "y\n", "more wip")
    run_git(repo, "switch", "-q", "main")
    run_git(
        repo, "merge", "-q", "--no-ff", "card-fix",
        "-m", "Merge pull request #9 from someone/card-fix", "-m", "Fix card layout on phones",
    )

    assert release.main(["--notes-file", str(out / "notes.md"), "--write-manifest"]) == 0

    assert (out / "output").read_text() == "release=true\nversion=1.1\nlevel=minor\n"
    assert (out / "notes.md").read_text() == (
        "### ✨ Enhancements\n\n"
        "- Add a last_scan attribute\n\n"
        "### 🐛 Fixes\n\n"
        "- Fix card layout on phones (#9)\n\n"
        "**Full changelog**: https://github.com/kedube/ha-network-scanner/compare/1.0.0...1.1\n"
    )
    assert "## Next release: 1.1" in (out / "summary").read_text()
    # Only the version string changed; the inline list kept its layout.
    manifest = (repo / release.MANIFEST).read_text()
    assert '"dependencies": ["frontend", "http"]' in manifest
    assert json.loads(manifest)["version"] == "1.1"


def test_main_without_shipped_changes(repo: Path, tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    out = tmp_path_factory.mktemp("out")
    monkeypatch.setenv("GITHUB_OUTPUT", str(out / "output"))
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    commit_file(repo, "README.md", "docs\n", "Update README")

    assert release.main(["--write-manifest"]) == 0
    assert (out / "output").read_text() == "release=false\nversion=\nlevel=\n"
    assert json.loads((repo / release.MANIFEST).read_text())["version"] == "1.0.0"
