# Digital Public Goods Standard: honest checklist

The product requirements (section 17) commit to meeting the [Digital Public Goods Standard](https://digitalpublicgoods.net/standard/).
This is where the repository stands against its nine indicators. **It is a self-assessment; nothing has been submitted or reviewed.**

| # | Indicator | Status | Notes |
|---|---|---|---|
| 1 | Relevance to the SDGs | Claimed | SDG 16, target 16.7 (responsive, inclusive, participatory and representative decision-making). Not yet reviewed by the DPG Alliance. |
| 2 | Use of approved open licences | Met in the repository | Code: Apache-2.0 (`LICENSE`). Documentation, law packs, floor and settings: CC BY 4.0 (`LICENSE-DOCS`). The product requirements proposed AGPL-3.0; the project chose Apache-2.0 (see `GOVERNANCE.md` for the trade-off). Dependency licences are not yet checked automatically in CI. |
| 3 | Clear ownership | Partly | No foundation exists. Copyright is held by "OpenParty contributors". Contributions are signed off under the Developer Certificate of Origin (`CONTRIBUTING.md`). |
| 4 | Platform independence | Partly | Every vendor sits behind an adapter (ID, SMS, payments, anchoring). Only simulators ship; no real provider is integrated yet. PostgreSQL, Go, Node.js are open source. |
| 5 | Documentation | Partly | README, `docs/architecture.md`, `docs/law-pack-authoring.md`, one-command Docker demo with the DDPN settings. No API reference (OpenAPI) and no per-adapter guides yet. |
| 6 | Mechanism for extracting data | Not met | No export of all party data in CSV/JSON yet, and no OpenAPI description. The register export is JSON for the contest register only. |
| 7 | Privacy and applicable laws | Partly | Privacy by design (per-member keys, crypto-shredding, no personal data on the log). No data protection impact assessment template per law pack yet; Nigeria requires one (NG-DP-01). |
| 8 | Standards and best practices | Partly | Translation files exist (English only). WCAG 2.2 AA is not assessed. OpenAPI, OpenID Connect and W3C Verifiable Credentials are not implemented. |
| 9A | Data privacy and security | Partly | Threat model exists in the product requirements. No independent audit, no bug bounty, no hardware key storage (a software key stands in). `SECURITY.md` states this. |
| 9B | Inappropriate and illegal content | Not met | Ratings and comment moderation (NG-SAF-02) are not built. |
| 9C | Protection from harassment | Not met | Anonymous option exists; the ombudsman channel and abuse reporting are not built. `CODE_OF_CONDUCT.md` covers the project community only. |

## Engineering rules from the requirements, and where we are

| Rule | Status |
|---|---|
| One public repository per component with README, licence, code of conduct, contributing guide, security policy | One repository for all components; the files exist |
| Semantic versioning, public changelog, signed releases (Sigstore) | Changelog exists; releases are not signed |
| Reproducible builds and an SBOM per release | Go build is reproducible by flags; no SBOM yet |
| Automated tests on every change; every law pack rule has a test | CI workflow in `.github/workflows/ci.yml`; rule coverage is by hand today |
| OpenSSF Scorecard and Best Practices badge | Not started |
| All user text in translation files | Done for the USSD and SMS text; portal text is still in the pages |
| No telemetry without opt-in | None present |

Open work, in rough order: data export and OpenAPI, dependency licence check in CI, SBOM and signed releases, portal translation files,
moderation and ombudsman modules, an independent security review.
