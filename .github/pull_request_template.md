## Summary

<!-- What does this PR change? -->

## Release / versioning

**Use a [Conventional Commits](https://www.conventionalcommits.org/) PR title** — e.g. `feat: …`, `fix: …`, `chore: …`, `docs: …`.

Squash merges use the **PR title** as the first line of the commit on `main`. **release-please** only uses that first line for the changelog and version bumps, so a title like `Add WebM ingest` will not create a release entry.

Examples:

- `feat: default WebM ingest for A/V sync`
- `fix: tear down FFmpeg when webm client disconnects`
- `chore: bump alpine base image`
