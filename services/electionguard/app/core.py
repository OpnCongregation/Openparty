"""
The cryptographic operations of an OpenParty election, as pure functions over JSON text. All the maths is the ElectionGuard
reference library (electionguard 1.4.0); nothing here is cryptography of our own. This module is imported by the service
(public data only) and by the guardian tool (private data, run on each guardian's own device).

State is never kept between calls: every function takes what it needs and returns what it made. A guardian's PRIVATE record is
only ever an input to, and output of, the guardian_* functions; the service never calls them with real guardians' secrets.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Dict, List, Optional

from electionguard.ballot import PlaintextBallot, PlaintextBallotContest, PlaintextBallotSelection, SubmittedBallot
from electionguard.ballot_box import cast_ballot
from electionguard.decryption_mediator import DecryptionMediator
from electionguard.decryption_share import CompensatedDecryptionShare, DecryptionShare
from electionguard.election import CiphertextElectionContext, make_ciphertext_election_context
from electionguard.encrypt import EncryptionDevice, encrypt_ballot
from electionguard.guardian import Guardian, PrivateGuardianRecord
from electionguard.key_ceremony import (
    CeremonyDetails,
    ElectionPartialKeyBackup,
    ElectionPublicKey,
    combine_election_public_keys,
    generate_election_key_pair,
)
from electionguard.manifest import (
    BallotStyle,
    Candidate,
    ContestDescription,
    ElectionType,
    GeopoliticalUnit,
    InternalManifest,
    InternationalizedText,
    Language,
    Manifest,
    ReportingUnitType,
    SelectionDescription,
    SpecVersion,
    VoteVariationType,
)
from electionguard.serialize import from_raw, to_raw
from electionguard.elgamal import ElGamalCiphertext
from electionguard.group import hex_to_p
from electionguard.tally import CiphertextTally

STYLE_ID = "style-1"
UNIT_ID = "unit-1"
TALLY_ID = "tally"


class ElectionError(ValueError):
    """A request that cannot be honoured (bad input, a failed check). The message is safe to show."""


def _dt(s: str) -> datetime:
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def sel_id(contest_id: str, candidate_id: str) -> str:
    return f"{contest_id}--{candidate_id}"


# ---------------------------------------------------------------- the election description ---------

def build_manifest(e: dict) -> dict:
    """
    e = {"id", "name", "start", "end", "contests": [{"id", "title", "candidates": [{"id", "name"}]}]}
    One choose-one contest per office; abstaining is leaving the contest empty. Returns the manifest JSON and its hash.
    """
    if not e.get("contests"):
        raise ElectionError("an election needs at least one contest")
    cands: List[Candidate] = []
    contests: List[ContestDescription] = []
    for i, c in enumerate(e["contests"]):
        if not c.get("candidates"):
            raise ElectionError(f"contest {c.get('id')} has no candidates")
        sels = []
        for j, cand in enumerate(c["candidates"]):
            cands.append(Candidate(cand["id"], InternationalizedText([Language(cand["name"], "en")]), None, None, False))
            sels.append(SelectionDescription(sel_id(c["id"], cand["id"]), j, cand["id"]))
        contests.append(ContestDescription(
            object_id=c["id"], sequence_order=i, electoral_district_id=UNIT_ID, vote_variation=VoteVariationType.one_of_m,
            number_elected=1, votes_allowed=1, name=c["title"], ballot_selections=sels))
    m = Manifest(
        election_scope_id=e["id"], spec_version=SpecVersion.EG0_95, type=ElectionType.primary,
        start_date=_dt(e["start"]), end_date=_dt(e["end"]),
        geopolitical_units=[GeopoliticalUnit(UNIT_ID, e["name"], ReportingUnitType.other)],
        parties=[], candidates=cands, contests=contests, ballot_styles=[BallotStyle(STYLE_ID, [UNIT_ID])],
        name=InternationalizedText([Language(e["name"], "en")]))
    if not m.is_valid():
        raise ElectionError("the election description is not valid")
    return {"manifest": to_raw(m), "manifest_hash": InternalManifest(m).manifest_hash.to_hex()}


def _manifest(raw: str) -> Manifest:
    return from_raw(Manifest, raw)


def combine_keys(public_keys: List[str], n: int, quorum: int) -> dict:
    """The joint election key from every guardian's public key. Everyone can recompute this."""
    keys = [from_raw(ElectionPublicKey, k) for k in public_keys]
    if len(keys) != n:
        raise ElectionError(f"expected {n} guardian keys, got {len(keys)}")
    if len({k.owner_id for k in keys}) != n:
        raise ElectionError("two guardians share an id")
    joint = combine_election_public_keys(keys)
    return {"joint_public_key": to_raw(joint), "n": n, "quorum": quorum}


def make_context(manifest_raw: str, joint_raw: str, n: int, quorum: int) -> dict:
    from electionguard.key_ceremony import ElectionJointKey
    m = _manifest(manifest_raw)
    joint = from_raw(ElectionJointKey, joint_raw)
    ctx = make_ciphertext_election_context(n, quorum, joint.joint_public_key, joint.commitment_hash, InternalManifest(m).manifest_hash)
    return {"context": to_raw(ctx)}


def _ctx(raw: str) -> CiphertextElectionContext:
    return from_raw(CiphertextElectionContext, raw)


# ---------------------------------------------------------------- ballots -----------------------------

def encrypt(manifest_raw: str, context_raw: str, ballot_id: str, choices: Dict[str, Optional[str]], device_seed: str = "openparty") -> dict:
    """
    Encrypt one ballot: choices maps contest id -> candidate id, or None to abstain. Returns the submitted (cast) ciphertext ballot
    and its public ballot code. The plaintext is not kept.
    """
    m = _manifest(manifest_raw)
    internal = InternalManifest(m)
    ctx = _ctx(context_raw)
    contests = []
    known = {c.object_id: {s.candidate_id: s.object_id for s in c.ballot_selections} for c in m.contests}
    for contest_id, cand in choices.items():
        if contest_id not in known:
            raise ElectionError("that contest is not on this ballot")
        if cand is None:
            continue
        if cand not in known[contest_id]:
            raise ElectionError("that candidate is not on this ballot")
        contests.append(PlaintextBallotContest(contest_id, [PlaintextBallotSelection(known[contest_id][cand], 1, False)]))
    # Contests the voter did not mark (abstained or not shown) are encrypted as "no selection": the ballot looks the same either way.
    marked = {c.object_id for c in contests}
    for contest_id in known:
        if contest_id not in marked:
            contests.append(PlaintextBallotContest(contest_id, []))
    seed = EncryptionDevice(1, 1, 1, device_seed).get_hash()
    # Proofs are verified when the ballot is added to the tally (and by verify_election), so they are not checked twice here.
    cb = encrypt_ballot(PlaintextBallot(ballot_id, STYLE_ID, contests), internal, ctx, seed, None, False)
    if cb is None:
        raise ElectionError("the ballot could not be encrypted")
    sb = cast_ballot(cb)
    return {"ballot": to_raw(sb), "ballot_code": cb.code.to_hex()}


def check_ballot(manifest_raw: str, context_raw: str, ballot_raw: str) -> bool:
    """Is this submitted ballot a well-formed encryption (all the zero-knowledge proofs verify)?"""
    ctx = _ctx(context_raw)
    sb = from_raw(SubmittedBallot, ballot_raw)
    internal = InternalManifest(_manifest(manifest_raw))
    return bool(sb.is_valid_encryption(internal.manifest_hash, ctx.elgamal_public_key, ctx.crypto_extended_base_hash))


# ---------------------------------------------------------------- tally -------------------------------

def _tally_to_json(t: CiphertextTally) -> str:
    """The encrypted tally as plain public values (the library's own object embeds the manifest and cannot be read back)."""
    return json.dumps({
        "ballots": sorted(t.cast_ballot_ids),
        "contests": {cid: {sid: [s.ciphertext.pad.to_hex(), s.ciphertext.data.to_hex()] for sid, s in c.selections.items()} for cid, c in t.contests.items()},
    })


def _tally_from_json(raw: str, internal: InternalManifest, ctx: CiphertextElectionContext) -> CiphertextTally:
    d = json.loads(raw)
    t = CiphertextTally(TALLY_ID, internal, ctx)
    for cid, sels in d["contests"].items():
        for sid, (pad, data) in sels.items():
            t.contests[cid].selections[sid].ciphertext = ElGamalCiphertext(hex_to_p(pad), hex_to_p(data))
    t.cast_ballot_ids.update(d["ballots"])
    return t


def tally(manifest_raw: str, context_raw: str, ballots: List[str], previous: Optional[str] = None) -> dict:
    """Add a batch of ballots to a running encrypted tally (optionally continuing from `previous`). Still encrypted."""
    internal = InternalManifest(_manifest(manifest_raw))
    ctx = _ctx(context_raw)
    t = _tally_from_json(previous, internal, ctx) if previous else CiphertextTally(TALLY_ID, internal, ctx)
    added = 0
    for raw in ballots:
        if t.append(from_raw(SubmittedBallot, raw), True):
            added += 1
        else:
            raise ElectionError("a ballot was refused by the tally (invalid or counted twice)")
    return {"tally": _tally_to_json(t), "added": added, "count": len(t)}


# ---------------------------------------------------------------- guardians (private; run on each guardian's own device) ---

def _wrap(g: Guardian, n: int, quorum: int) -> str:
    return json.dumps({"n": n, "quorum": quorum, "record": json.loads(to_raw(g.export_private_data()))})


def _load(private: str) -> Guardian:
    d = json.loads(private)
    return Guardian.from_private_record(from_raw(PrivateGuardianRecord, json.dumps(d["record"])), d["n"], d["quorum"])


def guardian_init(guardian_id: str, sequence_order: int, n: int, quorum: int) -> dict:
    """Make a guardian's secret key. The private record stays on the guardian's device; only `public` is sent anywhere."""
    if not (1 <= quorum <= n):
        raise ElectionError("the quorum must be between 1 and the number of guardians")
    kp = generate_election_key_pair(guardian_id, sequence_order, quorum)
    g = Guardian(kp, CeremonyDetails(n, quorum))
    return {"private": _wrap(g, n, quorum), "public": to_raw(g.share_key())}


def guardian_backups(private: str, all_public_keys: List[str]) -> dict:
    """Give every other guardian an encrypted share of this guardian's secret (so a quorum can stand in for an absent one)."""
    g = _load(private)
    d = json.loads(private)
    for pk in all_public_keys:
        g.save_guardian_key(from_raw(ElectionPublicKey, pk))
    if not g.generate_election_partial_key_backups():
        raise ElectionError("could not make the backups")
    out = [b for b in g.share_election_partial_key_backups() if b.designated_id != g.id]
    return {"private": _wrap(g, d["n"], d["quorum"]), "backups": [to_raw(b) for b in out]}


def guardian_receive(private: str, backups_for_me: List[str]) -> dict:
    """Check the backups other guardians made for this one. `all_verified` must be true for every guardian before the key is used."""
    g = _load(private)
    d = json.loads(private)
    verifications, ok = [], True
    for raw in backups_for_me:
        b = from_raw(ElectionPartialKeyBackup, raw)
        if b.designated_id != g.id:
            raise ElectionError("that backup is not addressed to this guardian")
        g.save_election_partial_key_backup(b)
        v = g.verify_election_partial_key_backup(b.owner_id)
        ok = ok and bool(v and v.verified)
        verifications.append({"from": b.owner_id, "verified": bool(v and v.verified)})
    return {"private": _wrap(g, d["n"], d["quorum"]), "verifications": verifications, "all_verified": ok and len(verifications) == d["n"] - 1}


def guardian_shares(private: str, manifest_raw: str, context_raw: str, tally_raw: str, all_public_keys: List[str]) -> dict:
    """
    This guardian's contribution to opening the tally: their own decryption share, plus a compensated share for every OTHER guardian,
    so any quorum of guardians can finish even if some do not show up. Only the total is ever decrypted, never a single ballot.
    """
    g = _load(private)
    ctx = _ctx(context_raw)
    t = _tally_from_json(tally_raw, InternalManifest(_manifest(manifest_raw)), ctx)
    share = g.compute_tally_share(t, ctx)
    if share is None:
        raise ElectionError("could not compute this guardian's share")
    comp = {}
    for pk in all_public_keys:
        other = from_raw(ElectionPublicKey, pk)
        if other.owner_id == g.id:
            continue
        cs = g.compute_compensated_tally_share(other.owner_id, t, ctx)
        if cs is not None:
            comp[other.owner_id] = to_raw(cs)
    return {"guardian_id": g.id, "share": to_raw(share), "compensated": comp}


# ---------------------------------------------------------------- opening the tally (public) -----------

def decrypt(manifest_raw: str, context_raw: str, tally_raw: str, all_public_keys: List[str], submissions: List[dict]) -> dict:
    """
    Combine the guardians' shares (any quorum) into the plaintext TOTAL. `submissions` are the outputs of guardian_shares.
    Returns counts per contest and candidate, plus the proof-carrying plaintext tally for publication.
    """
    m = _manifest(manifest_raw)
    ctx = _ctx(context_raw)
    t = _tally_from_json(tally_raw, InternalManifest(m), ctx)
    keys = {k.owner_id: k for k in (from_raw(ElectionPublicKey, p) for p in all_public_keys)}
    present = {s["guardian_id"] for s in submissions}
    if len(present) != len(submissions):
        raise ElectionError("a guardian submitted twice")
    if not present <= set(keys):
        raise ElectionError("a submission is from someone who is not a guardian")
    if len(present) < ctx.quorum:
        raise ElectionError(f"need {ctx.quorum} guardians; only {len(present)} took part")
    med = DecryptionMediator("openparty", ctx)
    for s in submissions:
        med.announce(keys[s["guardian_id"]], from_raw(DecryptionShare, s["share"]))
    med.validate_missing_guardians(list(keys.values()))
    missing = [gid for gid in keys if gid not in present]
    for s in submissions:
        for missing_id, raw in s["compensated"].items():
            if missing_id in missing:
                med.receive_tally_compensation_share(from_raw(CompensatedDecryptionShare, raw))
    med.reconstruct_shares_for_tally(t)
    plain = med.get_plaintext_tally(t, m)
    if plain is None:
        raise ElectionError("the tally could not be opened with these shares")
    counts: Dict[str, Dict[str, int]] = {}
    cand_of = {s.object_id: s.candidate_id for c in m.contests for s in c.ballot_selections}
    for cid, contest in plain.contests.items():
        counts[cid] = {cand_of[sid]: int(sel.tally) for sid, sel in contest.selections.items()}
    return {"counts": counts, "plaintext_tally": to_raw(plain), "guardians_present": sorted(present), "guardians_absent": sorted(missing)}


# ---------------------------------------------------------------- independent re-check -------------------

def verify_election(manifest_raw: str, context_raw: str, ballots: List[str], tally_raw: str) -> dict:
    """
    Re-check what was published, using only public data: every ballot is a valid encryption (its zero-knowledge proofs verify), ballots
    are unique, and the encrypted tally is exactly the sum of those ballots. NOT yet checked here: the proofs that each guardian's share
    of the decryption is correct. Until an independent verifier does that, the decrypted total is trusted only as far as the guardians are.
    """
    problems: List[str] = []
    internal = InternalManifest(_manifest(manifest_raw))
    ctx = _ctx(context_raw)
    seen = set()
    for i, raw in enumerate(ballots):
        sb = from_raw(SubmittedBallot, raw)
        if sb.object_id in seen:
            problems.append(f"ballot {sb.object_id} appears twice")
        seen.add(sb.object_id)
        if not sb.is_valid_encryption(internal.manifest_hash, ctx.elgamal_public_key, ctx.crypto_extended_base_hash):
            problems.append(f"ballot {sb.object_id}: encryption proofs do not verify")
    again = CiphertextTally(TALLY_ID, internal, ctx)
    for raw in ballots:
        again.append(from_raw(SubmittedBallot, raw), True)
    published = _tally_from_json(tally_raw, internal, ctx)
    for cid, contest in again.contests.items():
        for sid, sel in contest.selections.items():
            theirs = published.contests[cid].selections[sid].ciphertext
            if (sel.ciphertext.pad, sel.ciphertext.data) != (theirs.pad, theirs.data):
                problems.append(f"the encrypted tally for {sid} is not the sum of the published ballots")
    return {"ok": not problems, "problems": problems, "ballots": len(ballots)}

