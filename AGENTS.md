# Repository guidance

## Role and source of truth

- This repository is the public GitHub Pages deployment target. The Pages workflow publishes the checked-in `docs/` directory.
- The Angular source and ledger updater live in the companion private repository. Make application, calculation, and updater changes there, then use its publishing workflow to refresh `docs/` here.
- Treat `docs/` as generated output. Do not hand-edit hashed bundles unless the user specifically requests an output-only correction; arrange the corresponding source change as well.

## Public and private data

- `docs/data/ledger.json` is the public projection. Keep it free of the private `identities` object, credentials, and other private-only data.
- Never copy the private `data/ledger.json` into this repository.

## Deployment and Git hygiene

- Preserve `.github/workflows/pages.yml` and the compatibility code in `.github/pages/`; the workflow applies the patch before it deploys `docs/`.
- Check the working tree and stage only the files intended for this repository. Do not stage local caches, private snapshots, or temporary audit output.
