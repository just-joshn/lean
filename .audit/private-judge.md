# Private judge_throw gate.

## Behavior

The corrected judge requires exactly one exit and close, integer-zero statuses, explicit null signals, consistent collector identity, and create before exit before close. It validates the join record and requires both closure and rejection before join. Close before rejection remains accepted. Missing fields, booleans as integers, malformed values, duplicate packets, signal termination, and invalid join evidence are rejected with reasons.

The saved four valid cases remain accepted. The four recorded false acceptances are rejected. The 278 synthetic negatives are rejected, and both close-before-rejection controls remain accepted.

## Verification

The baseline gate exits 1 with four of four recorded false acceptances and 228 of 278 synthetic acceptances. The corrected gate exits 0 with four of four valid cases, zero of four false acceptances, zero of 278 synthetic acceptances, two of two close-before-rejection controls, and zero contract failures. The check pins the four exact case names to the frozen capture hashes, pins the four counterexample runtime and mutation labels, and enforces the claimed totals. The frozen controller and evidence copies are unchanged. `bun check` passes 74 files and the formatter passes 84.

## Open gates

- The frozen external prototype is unchanged. Adoption is still open; the copied judge is the candidate.
- Run-1 Node start-throw still has no historical collector close or join proof.
- The pinned Python reference uses `Popen/communicate`, so the gate proves the saved native observation contract, not general process parity.
- Normal-judge hardening, import, runtime, and stream metadata validation, metadata helper PATH ownership, and the live timeout backstop remain outside this correction.
- Descendants, timeout and drain behavior, process-group stop, interruption, spawn failures, finalizers, CLI behavior, and full environment acceptance remain unproved by this gate.
