# ElectionGuard service

The encrypted count for OpenParty. A thin wrapper around the **ElectionGuard reference library** (`electionguard` 1.4.0, MIT). It contains no cryptography of our own.

| File | What |
|---|---|
| `app/core.py` | Pure functions over JSON text: build the election description, combine guardian keys, encrypt a ballot, add ballots up, combine guardians' shares into the total, independently re-check |
| `app/server.py` | HTTP wrapper (standard library only). **Internal**: no published port, shared bearer token, no state, no logging of requests |
| `app/guardian_tool.py` | The guardian's own tool (init, backups, receive, shares). Runs on the guardian's device; never talks to the platform |
| `tests/test_core.py` | A whole election: a 5-guardian ceremony, quorum 3, opening the total with two guardians absent, tamper and drop detection |

Run the tests: `docker build -t openparty-eg . && docker run --rm --user 0 -v "$PWD:/srv" -w /srv openparty-eg sh -c "pip install pytest && python -m pytest -q tests"`
(about two minutes: the library is pure Python and does real cryptography). End to end with the platform: `node scripts/test-electionguard.mjs` from the repository root.

## Things to know

- **Python 3.10 only.** `electionguard` 1.4.0 predates a Python 3.11 dataclass change and will not import on 3.11 or later. The package metadata also declares GUI and database
  dependencies (Eel, pymongo, gevent...) that need a C compiler and are not used, so the Dockerfile installs the library without its declared dependencies and pins the few it needs.
  `dacite` is pinned to 1.6.0 because newer versions mis-read dates when the library reads its own files back.
- **The library logs raw cryptographic values at INFO and DEBUG.** `server.py` and `guardian_tool.py` switch all logging off before importing it. Do not turn it back on.
- **It is slow.** Roughly one to a few seconds per ballot (encrypt, then validate on tally). Fine for a trial; for a large electorate use the ElectionGuard C++ implementation,
  parallel workers and batch tally jobs. Not yet done.
- **Who sees plaintext.** Only `encrypt`, for voters who cannot encrypt on their own device (USSD, polling-unit terminal, and the web today): the choice is in this process's memory for that call and is not stored or logged.
  The `guardian/*` operations exist only when `EG_ENABLE_GUARDIAN_OPS=1`, for the local demo; with real guardians they are never enabled.
