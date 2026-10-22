## What this changes

<!-- Which layer: floor, core, law pack (which rule ids), party settings, portal, docs? -->

## Why

## How I checked it

- [ ] `npm test`, `go test ./...` and `npm run test:tools` pass
- [ ] `npm run validate:packs` passes (if a pack or party file changed)
- [ ] For a legal rule: the test that proves it changed with it, and the citation is quoted from the source
- [ ] No higher layer can now loosen a lower one
- [ ] No personal data reaches the public log
- [ ] Commits are signed off (`git commit -s`)

## What I did not test

<!-- Be plain. Reviewers prefer an honest gap to a hidden one. -->
