# The Charging Rally

This public repository holds the static site published with GitHub Pages.

## What is here

- `docs/` contains the published site and its public ledger data.
- `.github/workflows/pages.yml` deploys `docs/` to GitHub Pages when `main` or `work` changes.
- `.github/pages/` contains a small compatibility patch used by the Pages deployment workflow.

The Angular application and ledger updater live in a companion private repository. Its `Update ledger` workflow updates the ledger, builds the app, syncs the build output into this repository's `docs/` directory, and pushes the update here.

## Updating the site

Make application and ledger logic changes in the private source repository. Treat the files in `docs/` as generated publish output; avoid editing the built JavaScript and CSS bundles by hand.

## Public data

`docs/data/ledger.json` is the public projection used by the site. The private updater removes the `identities` field when creating that projection. Keep private identifiers, credentials, and the private source ledger out of this repository.
