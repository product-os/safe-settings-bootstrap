# probot-get-repo-settings

Generate repository settings files where they differ from [safe-settings](https://github.com/github/safe-settings) organization defaults.

This is useful for importing a current snapshot of all repo settings as repo/*.yml files
so it can be enabled org-wide without changing any repo settings.

A GitHub PAT with admin:read for the org and repos is required.
