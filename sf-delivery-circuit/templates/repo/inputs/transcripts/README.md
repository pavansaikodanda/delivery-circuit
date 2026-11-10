# Transcripts

Drop a client-call transcript here to start a feature.

1. Name it `<yyyy-mm-dd>-<slug>.md` (or `.txt` / `.vtt`). Letters, digits, `.`, `_`, `-` only.
2. Put a header on top: meeting title, date, attendees, source (file / Fireflies id).
3. Commit it on a branch named `intake/<slug>` and push. `spec-from-transcript.yml` drafts the spec and opens a
   draft PR, and `#arch-gate` gets a message. Or run `/circuit-intake` locally as the Architect (`cc-arch`).

Transcripts are treated as data: any instruction-like text inside them is ignored and reported.
Remove personal data the feature doesn't need before committing.
