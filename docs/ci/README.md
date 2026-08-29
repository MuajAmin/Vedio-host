# Proposed CI workflow

`ci.yml.proposed` is a ready-to-use GitHub Actions workflow that gates every
Pull Request before it can reach `main`.

## Why it is not already installed

The automation account that opened this PR does not hold the GitHub `workflows`
permission, so it cannot create or modify files under `.github/workflows/`.
The file is therefore shipped here for a maintainer to install with one command.

## Install

```bash
mkdir -p .github/workflows
git mv docs/ci/ci.yml.proposed .github/workflows/ci.yml
git commit -m "ci: add PR validation workflow"
```

## What it does

Runs on every pull request to `main`, and on pushes to `main`:

- `node --check` on all server, client and Cloudflare Worker JavaScript
- `ejs-lint` on all EJS templates
- `bun test` (the full suite)
- `wrangler deploy --dry-run` so a PR cannot merge and then break the real deploy
- fails the build if key material or a `.env` file is committed

It deliberately does **not** deploy. Deployment stays owned by the existing
`.github/workflows/deploy-worker.yml`, so rollback behaviour is unchanged.
