---
name: arch-design
description: Architect continues a draft Salesforce spec - records answers to open clarification questions, re-runs clarify and plan, draws the architecture in Lucid, mirrors the design to Confluence, and prepares G1 (plan sign-off), then stories and story review. Use with a spec folder name like 001-case-escalation.
---

# Architect: finish the design and prepare G1

Persona: **Architect** (`cc-arch`). Input: `$ARGUMENTS` = spec folder `NNN-slug`. Conventions: `circuit` skill.

1. **Branch:** check out `spec/NNN-slug` (fetch it if needed). Read `spec.md`, the clarification report, the
   constitution and, if present, `plan.md`.
2. **Open questions:** list every `OPEN` item, numbered. Ask the user for the answers (they are the human
   Architect or have the client's answers). Record each answer in `spec.md` → "Clarification Status" with who
   answered and the date. Never invent an answer.
3. **Re-clarify:** run `/speckit-sf-clarify`. Repeat step 2 until nothing is `OPEN`.
4. **Plan:** run `/speckit-sf-plan` if `plan.md` is missing or older than the latest `spec.md` change.
   Check that it lists reuse decisions (existing objects/flows/classes found in `dev`), the blast radius, and
   the security model. Leave Architect Sign-Off **unticked**: the guard blocks you from ticking it anyway.
5. **Diagram:** with the Lucid MCP, create or update "NNN-slug architecture": objects and relationships,
   automation (flows, triggers, handlers), LWCs, integrations, personas and their access. Put the Lucid link in
   `plan.md` → "Diagrams".
6. **Confluence mirror:** with the Atlassian MCP, create or update page "Design: <feature>" in the space from
   `build.config.yml` (`confluence.space_key`): spec summary, object map, security model, diagram embed, open
   risks, links to the files on the `spec/` branch. Status "Awaiting architect approval".
7. **Commit** and print the push command.
8. **Hand over to the human Architect (G1):**
   > Review `plan.md` and the Confluence page. If you approve, tick `Overall Sign-Off: [x] APPROVED` in `plan.md`
   > yourself, commit and push. Then run `/speckit-sf-stories` and `/speckit-sf-review` (or ask me to), and ask
   > the Developer for `dev-review-stories` and the Tester for `qa-design-tests`.

After G1, when asked to generate stories: run `/speckit-sf-stories` (it must create `task_story_00.md` first),
then `/speckit-sf-review`, fix BLOCKER findings in the stories, commit, and name the next owners.
