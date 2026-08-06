<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: LicenseRef-Proprietary
-->

# 0004. React Router 7 for the web application

- **Status:** Accepted
- **Date:** 2026-08-06
- **Source:** `.scratch/blackout-v1/issues/07-language-and-framework.md`

## Context

PRD §12.4 targets WCAG 2.2 Level AA across queue, case, report and administration flows, and §15.5
blocks a release on any unresolved critical WCAG finding in the core queue or case flow.
Accessibility is an acceptance gate, not polish. The queue must be keyboard-first (FR-QUE-008) and
support optimistic assignment updates with conflict detection (§9.2), and the whole application must
run in a community Docker profile with no commercial control plane (FR-TEN-002).

## Decision

React Router 7 in framework mode, server-rendered, with React Aria Components for accessible
composite widgets. Every mutation is a form POST to an action that works without JavaScript;
progressive enhancement adds optimistic updates via fetchers with an expected-version field for
conflict detection.

## Consequences

Server-rendered plain forms are the shortest path to keyboard-correct, screen-reader-correct
interaction, and the loader/action/fetcher model provides optimistic updates with conflict detection
as a built-in rather than a hand-rolled pattern. It self-hosts as an ordinary Node container.

**Recorded caveat:** SvelteKit was judged to have the better accessibility story — build-time a11y
warnings and a smaller client payload. React Router was chosen on ecosystem depth and hiring pool,
not on technical merit alone. If accessibility findings become a recurring drag in Release C, this
is the decision to revisit.
