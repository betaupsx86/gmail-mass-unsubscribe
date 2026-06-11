# Development

Run `./scripts/setup-dev.sh` to generate a local `dev/` build with a
separate OAuth client ID for unpacked testing, then load `dev/` in
`chrome://extensions`. See [NOTES.md](NOTES.md) for implementation notes
and known edge cases.

`manifest.json` at the repo root always stays the published/prod version
— never edit its `client_id` for local testing. Re-run
`./scripts/setup-dev.sh` after every source edit, then click reload on
the extension card in `chrome://extensions`.
