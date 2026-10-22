# Contributing to OpenParty

Thank you for looking. This project is for public review, and critical review is the most useful contribution.

## What is most useful right now

1. **Legal review of a law pack.** Does a rule in `packs/ng/v1/pack.yaml` match the law it cites? Open an issue with the rule id (for example `NG-FIN-02`), the source text, and what differs. The Nigeria pack is a **draft transcribed from a product requirements document and has not been reviewed by counsel**.
2. **Security review.** See [SECURITY.md](SECURITY.md). Please do not post vulnerabilities in public issues.
3. **A new law pack.** Copy the format in [docs/law-pack-authoring.md](docs/law-pack-authoring.md). Every rule needs a citation and a test.
4. **An ID adapter.** Implement `IdAdapter` and pass the conformance suite (`services/platform/test/adapter-conformance.ts`).
5. **Translations.** Text lives in `services/platform/locales/*.json`. Please contribute a language only if you are a native speaker, or have one review it. Machine translation of political and legal wording is not accepted.

## Ground rules

- **The layers.** Core and the international floor change only through foundation releases. A law pack may switch a feature off where national law forbids it, and a party may only tighten the law. A change that lets a higher layer loosen a lower one will be declined.
- **No personal data on the public log.** `assertNoPersonalData` exists for a reason.
- **Every legal rule needs a test.** If you change a number in a pack, the test that proves it must change with it.
- **No home-made cryptography.** Use the standard library or an audited package.
- **No telemetry** without explicit opt-in.
- **User text goes in locale files**, not in code.

## Development

```
npm install
npm test                  # platform and portal
(cd services/trustlog && go test ./...)
npm run test:tools        # tests for the report script
npm run report            # runs everything and writes reports/latest.json
```

Node 22+ and Go 1.22+. Docker is optional (see the README).

## Sign your commits (Developer Certificate of Origin)

Each commit must carry a `Signed-off-by` line, which certifies you have the right to submit the work under the project licence
([developercertificate.org](https://developercertificate.org/)):

```
git commit -s -m "Describe the change"
```

## Licence of contributions

Code you contribute is licensed under Apache-2.0 (see [LICENSE](LICENSE)); documentation, law packs, floor and settings under
CC BY 4.0 (see [LICENSE-DOCS](LICENSE-DOCS)).

## Pull requests

Keep them small and say which rule, floor item or module they touch. Run the tests first. Be honest in the description about
what you did not test.
