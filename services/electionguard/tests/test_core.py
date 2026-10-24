"""
A whole election through the same functions the platform and the guardians' tool use: a 5-guardian key ceremony with a quorum of 3,
encrypted ballots, an encrypted tally, and opening the tally with only 3 guardians present. Run: python -m pytest -q
"""
import json
import random

import pytest

from app import core

N, QUORUM = 5, 3
GIDS = [f"guardian-{i}" for i in range(1, N + 1)]


def ceremony():
    """The distributed key ceremony: each guardian works on their own, only public messages move between them."""
    inits = {g: core.guardian_init(g, i + 1, N, QUORUM) for i, g in enumerate(GIDS)}
    publics = [inits[g]["public"] for g in GIDS]
    state = {g: inits[g]["private"] for g in GIDS}
    inbox = {g: [] for g in GIDS}
    for g in GIDS:
        out = core.guardian_backups(state[g], publics)
        state[g] = out["private"]
        for raw in out["backups"]:
            inbox[json.loads(raw)["designated_id"]].append(raw)
    for g in GIDS:
        assert len(inbox[g]) == N - 1
        out = core.guardian_receive(state[g], inbox[g])
        assert out["all_verified"], out["verifications"]
        state[g] = out["private"]
    return state, publics


def election(contests):
    return {"id": "test-election", "name": "Test primary", "start": "2026-12-01T09:00:00Z", "end": "2026-12-01T18:00:00Z", "contests": contests}


CONTESTS = [
    {"id": "chair", "title": "National Chairman", "candidates": [{"id": "ada", "name": "Ada"}, {"id": "bayo", "name": "Bayo"}, {"id": "chi", "name": "Chi"}]},
    {"id": "sec", "title": "Secretary", "candidates": [{"id": "dan", "name": "Dan"}, {"id": "efe", "name": "Efe"}]},
]


@pytest.fixture(scope="module")
def world():
    state, publics = ceremony()
    man = core.build_manifest(election(CONTESTS))
    joint = core.combine_keys(publics, N, QUORUM)
    ctx = core.make_context(man["manifest"], joint["joint_public_key"], N, QUORUM)["context"]
    return {"state": state, "publics": publics, "manifest": man["manifest"], "context": ctx}


POOL_SIZE = 12


@pytest.fixture(scope="module")
def pool(world):
    """Twelve encrypted ballots, made once (encryption is the slow part) and shared by the tests below."""
    rng = random.Random(11)
    out = []
    for i in range(POOL_SIZE):
        choice = {"chair": rng.choice(["ada", "bayo", "chi", None]), "sec": rng.choice(["dan", "efe", None])}
        out.append((choice, core.encrypt(world["manifest"], world["context"], f"b{i}", choice)["ballot"]))
    return out


def cast(pool, n, start=0):
    expected = {"chair": {"ada": 0, "bayo": 0, "chi": 0}, "sec": {"dan": 0, "efe": 0}}
    chosen = pool[start:start + n]
    for choice, _ in chosen:
        for c, v in choice.items():
            if v:
                expected[c][v] += 1
    return [b for _, b in chosen], expected


def open_tally(world, t, present):
    subs = [core.guardian_shares(world["state"][g], world["manifest"], world["context"], t, world["publics"]) for g in present]
    return core.decrypt(world["manifest"], world["context"], t, world["publics"], subs)


def test_count_is_right_with_all_guardians(world, pool):
    ballots, expected = cast(pool, 12)
    t = core.tally(world["manifest"], world["context"], ballots)["tally"]
    assert open_tally(world, t, GIDS)["counts"] == expected


def test_count_is_right_with_only_a_quorum_present(world, pool):
    ballots, expected = cast(pool, 10)
    t = core.tally(world["manifest"], world["context"], ballots)["tally"]
    out = open_tally(world, t, ["guardian-1", "guardian-3", "guardian-5"])  # two guardians never show up
    assert out["counts"] == expected
    assert out["guardians_absent"] == ["guardian-2", "guardian-4"]


def test_too_few_guardians_cannot_open_the_tally(world, pool):
    ballots, _ = cast(pool, 4)
    t = core.tally(world["manifest"], world["context"], ballots)["tally"]
    with pytest.raises(core.ElectionError, match="need 3"):
        open_tally(world, t, ["guardian-1", "guardian-2"])


def test_any_quorum_gives_the_same_answer(world, pool):
    ballots, expected = cast(pool, 8)
    t = core.tally(world["manifest"], world["context"], ballots)["tally"]
    for present in (["guardian-1", "guardian-2", "guardian-3"], ["guardian-2", "guardian-4", "guardian-5"], ["guardian-1", "guardian-4", "guardian-5"]):
        assert open_tally(world, t, present)["counts"] == expected


def test_batches_add_up_to_the_same_tally(world, pool):
    ballots, expected = cast(pool, 9)
    a = core.tally(world["manifest"], world["context"], ballots[:4])
    b = core.tally(world["manifest"], world["context"], ballots[4:], previous=a["tally"])
    assert b["count"] == 9
    assert open_tally(world, b["tally"], ["guardian-2", "guardian-3", "guardian-4"])["counts"] == expected


def test_an_empty_ballot_and_an_abstention_are_both_fine(world):
    ballots = [core.encrypt(world["manifest"], world["context"], "x1", {"chair": None, "sec": None})["ballot"],
               core.encrypt(world["manifest"], world["context"], "x2", {"chair": "ada"})["ballot"]]
    t = core.tally(world["manifest"], world["context"], ballots)["tally"]
    out = open_tally(world, t, GIDS[:3])["counts"]
    assert out["chair"] == {"ada": 1, "bayo": 0, "chi": 0} and out["sec"] == {"dan": 0, "efe": 0}


def test_a_ballot_cannot_be_counted_twice_or_for_a_stranger(world):
    one = core.encrypt(world["manifest"], world["context"], "dup", {"chair": "ada"})["ballot"]
    with pytest.raises(core.ElectionError):
        core.tally(world["manifest"], world["context"], [one, one])
    with pytest.raises(core.ElectionError, match="not on this ballot"):
        core.encrypt(world["manifest"], world["context"], "bad", {"chair": "zed"})
    with pytest.raises(core.ElectionError, match="not on this ballot"):
        core.encrypt(world["manifest"], world["context"], "bad2", {"nope": "ada"})


def test_a_stored_ballot_holds_no_plaintext_vote(world):
    raw = core.encrypt(world["manifest"], world["context"], "secret", {"chair": "bayo", "sec": "efe"})["ballot"]
    d = json.loads(raw)
    selections = [s for c in d["contests"] for s in c["ballot_selections"]]
    assert selections
    for sel in selections:
        # what is stored is the ciphertext and its proofs; neither the vote nor the encryption nonce is kept
        assert "vote" not in sel
        assert not sel.get("nonce")
        assert "ciphertext" in sel and "proof" in sel


def test_the_independent_check_passes_and_catches_a_dropped_ballot(world, pool):
    ballots, _ = cast(pool, 6)
    t = core.tally(world["manifest"], world["context"], ballots)["tally"]
    assert core.verify_election(world["manifest"], world["context"], ballots, t)["ok"]
    dropped = core.verify_election(world["manifest"], world["context"], ballots[:-1], t)
    assert not dropped["ok"] and any("not the sum" in p for p in dropped["problems"])
    assert core.check_ballot(world["manifest"], world["context"], ballots[0])


def test_a_tampered_ballot_fails_its_proofs(world, pool):
    ballots, _ = cast(pool, 2)
    d = json.loads(ballots[0])
    sel = d["contests"][0]["ballot_selections"][0]
    sel["ciphertext"]["data"], d["contests"][0]["ballot_selections"][1]["ciphertext"]["data"] = (
        d["contests"][0]["ballot_selections"][1]["ciphertext"]["data"], sel["ciphertext"]["data"])
    try:
        ok = core.check_ballot(world["manifest"], world["context"], json.dumps(d))
    except Exception:
        ok = False
    assert not ok


def test_a_backup_made_for_someone_else_does_not_verify():
    inits = {g: core.guardian_init(g, i + 1, N, QUORUM) for i, g in enumerate(GIDS)}
    publics = [inits[g]["public"] for g in GIDS]
    out = core.guardian_backups(inits["guardian-1"]["private"], publics)
    bad = json.loads(out["backups"][0])
    who = bad["designated_id"]
    impostor = core.guardian_init(who, GIDS.index(who) + 1, N, QUORUM)  # same id, different secret key
    try:
        r = core.guardian_receive(impostor["private"], [json.dumps(bad)])
    except Exception:
        return  # refused outright: also fine
    assert not r["all_verified"]
