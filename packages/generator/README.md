<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# @blackout/generator

Deterministic synthetic telemetry with ground-truth labels. Test infrastructure — never shipped, and
never a source of production data.

With no customer and no real telemetry, every analyser, detector and rule in this project is
validated against this package. That places two hard requirements on it: output must be
byte-reproducible from a seed, and synthetic data must never be mistakable for real data.

## Scenarios

Fourteen reference scenarios covering PRD §15.2's mandatory edge cases plus three the platform
research made mandatory. Each damages a clean baseline in one documented way and records what it did.

Every scenario carries a **trap** — a plain statement of what a naive detector gets wrong. That is
the point of the fixture. Deep Sleep, for instance, disables both jamming detectors, so the absence
of a jamming flag is not weak evidence against jamming; it is no evidence, and a rule that evaluates
it to false is wrong rather than merely imprecise.

## Determinism

No `Date.now()`, no `Math.random()`. Start time is always supplied by the caller and randomness comes
from a seeded generator, so a scenario replays identically forever. There is a test that stubs both
globals to throw, so this cannot regress quietly.

Labels live in a sidecar, never inside the events — a test asserts no label field appears in
serialized output, so ground truth cannot leak into the data under test.
