# safe-settings-bootstrap

Bootstrap organization-level [safe-settings](https://github.com/github/safe-settings) manifests.

Create manifests following the balena opinionated defaults for repository settings across an entire org
without losing existing branch protection checks.

Either export the env vars or create an `.env` with the following content:

```bash
# GitHub PAT with org:admin:read and repo:admin:read
GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz
# Organization name
ORG_NAME=balena-io-experimental
```

Execute in the `<org>/.github` repository with `npmx safe-settings-bootstrap`.