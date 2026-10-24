"""
The guardian's own tool. A guardian runs this on a device they control, ideally offline, so their secret key never touches the
platform or the network. Files are plain JSON; only the *.public.json, backups, verifications and shares files are ever sent to the
platform. The *.private.json file is the guardian's key: keep it offline, back it up in two places, and never upload it.

  python -m app.guardian_tool init     --id <admin id> --seq 1 --n 5 --quorum 3 --out me.private.json --public-out me.public.json
  python -m app.guardian_tool backups  --private me.private.json --keys all-public-keys.json --out-private me.private.json --out backups.json
  python -m app.guardian_tool receive  --private me.private.json --backups backups-for-me.json --out-private me.private.json --out verifications.json
  python -m app.guardian_tool shares   --private me.private.json --manifest manifest.json --context context.json --tally tally.json --keys all-public-keys.json --out my-shares.json

With Docker (nothing to install):  docker run --rm -v "$PWD:/data" -w /data openparty-eg python -m app.guardian_tool <command> ...
"""
from __future__ import annotations

import json
import logging
import os
import sys

logging.disable(logging.CRITICAL)  # the library logs raw cryptographic values

import click  # noqa: E402

from . import core  # noqa: E402


def _read(path: str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write(path: str, data, private: bool = False):
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600 if private else 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)


def _fail(e: Exception):
    click.echo(f"error: {e}", err=True)
    sys.exit(1)


@click.group()
def cli():
    """OpenParty guardian tool."""


@cli.command()
@click.option("--id", "gid", required=True, help="your admin id on the platform")
@click.option("--seq", type=int, required=True, help="your position, 1 to n, as assigned by the platform")
@click.option("--n", type=int, required=True)
@click.option("--quorum", type=int, required=True)
@click.option("--out", required=True, help="where to write your PRIVATE key file")
@click.option("--public-out", required=True, help="where to write your public key (this one is uploaded)")
def init(gid, seq, n, quorum, out, public_out):
    try:
        r = core.guardian_init(gid, seq, n, quorum)
    except core.ElectionError as e:
        _fail(e)
    _write(out, {"private": r["private"]}, private=True)
    _write(public_out, {"public": r["public"]})
    click.echo(f"wrote {out} (KEEP PRIVATE, back it up) and {public_out} (upload this one)")


@cli.command()
@click.option("--private", required=True)
@click.option("--keys", required=True, help="the file of every guardian's public key, from the platform")
@click.option("--out-private", required=True)
@click.option("--out", required=True, help="backups to upload")
def backups(private, keys, out_private, out):
    try:
        r = core.guardian_backups(_read(private)["private"], _read(keys)["public_keys"])
    except core.ElectionError as e:
        _fail(e)
    _write(out_private, {"private": r["private"]}, private=True)
    _write(out, {"backups": r["backups"]})
    click.echo(f"wrote {len(r['backups'])} encrypted backups to {out}")


@cli.command()
@click.option("--private", required=True)
@click.option("--backups", "backups_file", required=True, help="the backups other guardians made for you, from the platform")
@click.option("--out-private", required=True)
@click.option("--out", required=True, help="your verifications, to upload")
def receive(private, backups_file, out_private, out):
    try:
        r = core.guardian_receive(_read(private)["private"], _read(backups_file)["backups"])
    except core.ElectionError as e:
        _fail(e)
    _write(out_private, {"private": r["private"]}, private=True)
    _write(out, {"verifications": r["verifications"], "all_verified": r["all_verified"]})
    click.echo("all backups verified" if r["all_verified"] else "SOME BACKUPS DID NOT VERIFY: do not proceed; tell the secretary")


@cli.command()
@click.option("--private", required=True)
@click.option("--manifest", required=True)
@click.option("--context", required=True)
@click.option("--tally", required=True)
@click.option("--keys", required=True)
@click.option("--out", required=True, help="your shares of the total, to upload")
def shares(private, manifest, context, tally, keys, out):
    try:
        r = core.guardian_shares(_read(private)["private"], _read(manifest)["manifest"], _read(context)["context"], _read(tally)["tally"], _read(keys)["public_keys"])
    except core.ElectionError as e:
        _fail(e)
    _write(out, r)
    click.echo(f"wrote your shares to {out}. They open only the TOTAL, never a single ballot.")


if __name__ == "__main__":
    cli()
