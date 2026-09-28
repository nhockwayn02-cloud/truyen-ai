# V12.6 — Character Core Identity Lock

## Problem fixed
Character Database entries such as a character's original personality/identity could be overwritten by automatic character rescans after several chapters. The automatic tier-ranking button only changes `tier`, but the chapter character updater could overwrite core fields when AI returned a new paraphrase.

## Changes
- Added `coreIdentity` snapshot for `name`, `age`, `gender`, `appearance`, `personality`, and `goals`.
- `coreLocked` defaults to true.
- Automatic chapter character extraction can no longer overwrite core identity fields unless the AI explicitly returns `explicitCoreChange=true` plus concrete `changeEvidence`.
- Manual Save in Character Database is treated as user intent and refreshes the core snapshot.
- Existing characters without a core snapshot are initialized from their current profile once; this prevents future automatic overwrites. If an already-corrupted profile must be restored to an earlier value, restore it manually once and press Save.
- Automatic tier ranking remains limited to `tier`; it does not modify personality, appearance, role, goals, etc.
