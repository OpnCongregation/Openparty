# Security policy

OpenParty handles political affiliation, which is sensitive personal data in many countries. We take reports seriously.

## Status

This is a **pre-release reference implementation**. It has had no independent security audit, no red team, and no protocol proof
(see section 20 of the product requirements). Do not run it for real members. Several components are simulated: national ID
verification, SMS, payments, the hardware security module (a software key stands in), and blockchain anchoring unless you switch it on.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.**

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability").

You can also email the maintainer directly: **Ayafa Tonye Amada, ayafatonye@gmail.com**. Please put "OpenParty security" in the subject line. For anything sensitive, ask for an encrypted channel first rather than sending details in the clear.

Please include what you found, how to reproduce it, and what an attacker gains. We will acknowledge a report within 7 days and
tell you what we plan to do. We will credit you if you want credit.

## Scope

In scope: the platform (`services/platform`), the trust log and witness (`services/trustlog`), the portal (`apps/portal`), the law pack
engine, and the Docker configuration.

Of special interest: anything that lets a single person change a register, a rule, a vote or the log without witnesses noticing; any path
that puts personal data on the public log; any way to loosen a law pack from a party setting; and anything that defeats the
append-only tables.

Out of scope: findings that depend on the simulators (a fake NIN check "accepts" fake numbers by design), and denial of service by
volume against a developer machine.

## Bounty

There is no bug bounty yet. The product requirements call for a public bounty of at least 60 days before a first primary.
