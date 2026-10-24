#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Use the upstream profile owner to keep Soft Axiom separate from existing OpenClaw state.
process.env.OPENCLAW_PROFILE ??= "softaxiom";
// An environment profile name alone does not select the upstream state directory.
// Explicit --profile/--dev still switch these canonical inherited defaults normally.
process.env.OPENCLAW_STATE_DIR ??= resolve(
  process.env.OPENCLAW_HOME || homedir(),
  process.env.OPENCLAW_PROFILE === "default"
    ? ".openclaw"
    : `.openclaw-${process.env.OPENCLAW_PROFILE}`,
);
// The upstream entry guard and child launchers require the canonical bootstrap path.
process.argv[1] = fileURLToPath(new URL("./openclaw.mjs", import.meta.url));
await import("./openclaw.mjs");
