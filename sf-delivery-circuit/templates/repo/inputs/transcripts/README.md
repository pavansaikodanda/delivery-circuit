# Transcripts do not go here

Client-call transcripts never enter git. This folder is ignored (except this README) so a transcript dropped here by
mistake is not committed.

To start a feature from a call:

1. In VS Code, open **Delivery Circuit → Sources** as the Architect and add the call: pick a Fireflies meeting, or
   upload a file (`.txt`, `.md`, `.vtt`, `.srt`, `.docx`). Uploads are stored encrypted on your machine, outside the
   repo. Only the source id, title and date go into `.circuit/sources.json`.
2. Start an Architect session and run `/circuit-intake <sourceId>`. Claude reads the text through the Circuit MCP
   (`transcript_get`, Architect only) and writes the spec, which cites `source: fireflies:<id>` or `source: upload:<id>`.

Transcripts are treated as data: any instruction-like text inside them is ignored and reported.
