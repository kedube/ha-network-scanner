# Contributing

Thanks for helping out. This page covers the code layout, running the tests, the README screenshots, what CI checks, and how releases are made.

## Code layout

Everything that ships is in [custom_components/network_scanner](custom_components/network_scanner):

- `config_flow.py`: the config flow (IP range, mappings, interval) and options flow (mappings, interval). Validates input and checks that `nmap` runs before creating an entry.
- `__init__.py`: entry setup, unload, options reload, the version 1 to 2 entry migration, and serving the dashboard card at an address that carries the integration version.
- `coordinator.py`: a `TimestampDataUpdateCoordinator` that runs the blocking scan in the executor on the configured interval and records when the last successful scan finished.
- `scanner.py`: the nmap client, with no Home Assistant imports. Ping sweep (`-sn`), MAC and vendor extraction, bounded parallel reverse DNS, and MAC mapping parsing.
- `sensor.py`: the sensor entity. Its state is the device count, and its attributes are `devices`, `ip_range` and `last_scan`. `devices` and `last_scan` are excluded from the recorder. Its device reports the integration version, which the card checks itself against.
- `frontend/network-scanner-card.js`: the dashboard card, a dependency-free custom element shipped as-is with no build step.
- `brand/`: the integration's icon, light and dark at 1x and 2x, which Home Assistant 2026.3 and later serve from here. The same files are in the [brands repository](https://github.com/home-assistant/brands/tree/master/custom_integrations/network_scanner) for older versions and for HACS.

## Running the tests

The integration's tests use [pytest-homeassistant-custom-component](https://github.com/MatthewFlamm/pytest-homeassistant-custom-component), which pins a matching Home Assistant version. You need Python 3.14.

```sh
python3.14 -m venv .venv
source .venv/bin/activate
pip install -r requirements_test.txt

pytest                    # the integration's tests
pytest --cov              # the same, with a coverage report (CI requires 95%)
ruff check .              # lint
```

Neither nmap nor a network is needed. `tests/common.py` replaces the nmap binary with a fake that feeds recorded `nmap -oX` output ([tests/fixtures/nmap_ping_sweep.xml](tests/fixtures/nmap_ping_sweep.xml)) through python-nmap's real parser, and reverse DNS is answered from a dict.

The dashboard card has its own tests. They load `network-scanner-card.js` into [jsdom](https://github.com/jsdom/jsdom) and need Node.js 24 or newer:

```sh
npm ci
npm test
```

Both test suites use [tests/fixtures/sweep_devices.json](tests/fixtures/sweep_devices.json): the Python tests check that the integration produces exactly that device list, and the card tests render it. If you change what the sensor reports, update that file and both suites follow.

## README screenshots

The card screenshots in [images/](images) are rendered from the real card file, with made-up devices, so they never show anyone's actual network. After changing how the card looks, regenerate them and commit the new images:

```sh
npm ci
npm run screenshots
```

[scripts/screenshots.mjs](scripts/screenshots.mjs) runs the card in headless Chrome with Home Assistant's default light and dark themes, and holds the example devices. It uses Google Chrome if it's installed, and otherwise Playwright's Chromium, which `npx playwright-core install chromium` downloads.

## Continuous integration

[.github/workflows/ci.yaml](.github/workflows/ci.yaml) runs on every pull request, on every push to `main`, and daily:

| Job | What it checks |
|-----|----------------|
| Lint | `ruff check` |
| Tests (integration) | the pytest suite, with coverage |
| Tests (dashboard card) | the card's jsdom tests |
| hassfest | Home Assistant's own validation of the manifest, translations and structure |
| HACS validation | the rules HACS applies to repositories: description, topics, issues enabled, brand icons and so on |
| Release | on pull requests, a preview of the release notes in the job summary; on `main`, the release itself |

Dependabot opens weekly pull requests for the GitHub Actions, the Python test requirements (which brings in new Home Assistant versions) and the card's test dependencies.

## Releases

Releases are automatic. After lint, both test suites and hassfest pass on a push to `main`, the Release job:

1. decides whether there is anything to release. Only changes to what HACS installs count: `custom_components/` and `hacs.json`. A push that only touches docs, tests or CI doesn't release; those changes go out with the next release.
2. works out the next version from the commit messages since the last release (see below).
3. sets that version in `manifest.json`, commits it to `main` as **Release x.y.z**, and tags that commit. The tag is the version HACS shows and the manifest is the version Home Assistant shows, so they always match.
4. publishes a GitHub release. The release notes are generated from the same commit messages, and HACS shows them to users before they update.

Because the release commit goes onto `main`, run `git pull` before your next push.

The dashboard card is versioned by the same step, so don't give it a version of its own. The integration serves it as `network-scanner-card.js?v=<manifest version>&h=<content hash>`. The card reads `v` from its own URL, logs it in the browser console, and compares it with the version the sensor's device reports (`sw_version`), offering a refresh when a page is still running a card from another release.

To preview the next release at any time, run:

```sh
./scripts/release.py
```

### Writing commit messages

The first line of each commit becomes a line in the release notes, so write it for someone using the integration. The type of change also decides the version bump:

| Change | Version bump | Release notes section | How it's recognized |
|--------|--------------|-----------------------|---------------------|
| Breaking | major (3.0.0) | ⚠️ Breaking changes | `BREAKING CHANGE:` in the message, or `!` after the type: `feat!: …` |
| Enhancement | minor (2.3.0) | ✨ Enhancements | `feat:` or `perf:`, or a message like "Add …", "Support …", "Improve …", "Performance …" |
| Fix | patch (2.2.1) | 🐛 Fixes | `fix:`, or a message like "Fix …", "Restore …", "Correct …" |
| Anything else | patch | 🔧 Other changes | any other message |
| Maintenance | none of its own | left out | `docs:`, `test:`, `ci:`, `build:`, `chore:`, `refactor:`, `style:`, or any commit that changes nothing HACS installs |

[Conventional Commits](https://www.conventionalcommits.org/) prefixes are the most reliable, but plain messages work too. A scope is shown in bold: `fix(card): keep rows open across scans` becomes "**card:** Keep rows open across scans".

A merged pull request appears once, under its title, with its number linked. The commits inside it are not listed.

Bullet points in a commit body become sub-points in the release notes, which is a good place for highlights:

```text
Add a dashboard card

- Search by name, IP, MAC or vendor
- Scan now button
```

### Releasing by hand

- **Release now, or pick the bump yourself:** go to **Actions > CI > Run workflow** on `main` and choose `patch`, `minor` or `major`. That releases even if only docs changed.
- **Jump to a specific version:** set `version` in [manifest.json](custom_components/network_scanner/manifest.json) in your commit. If it's higher than the version the commits call for, the release uses it.

Don't otherwise edit the version in `manifest.json`. The release job owns it.
