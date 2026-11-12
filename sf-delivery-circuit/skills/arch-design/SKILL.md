---
name: arch-design
description: Architect finishes a feature design on its Confluence design page - records answers to open questions as decisions, drafts the technical plan and data model, builds the org snapshot child page from the DEV org, draws the architecture in Lucid, and prepares the human design approval (G1). Use with a feature id like 001-shipping-rates or the design page link.
---

# Architect: finish the design and prepare G1

Persona: **Architect** (`cc-arch`). Input: `$ARGUMENTS` = `NNN-slug` or the design page URL/id.
Conventions: `circuit` skill. Writes: Confluence (design page + "Org snapshot" child), Lucid, local `.specify/` only.

1. **Read** the design page (`getConfluenceContent`; find it with `searchConfluence` `label = "feature-NNN"`), its
   Decisions table, the constitution and `CLAUDE.md`. If the page status is Approved, stop: changes after approval
   need a new approval (tell the Architect; see `arch-approve-design`).
2. **Open questions:** list each, numbered. Ask the user for the answers (they are the human Architect or have the
   client's). Record each answer with `record-decision` (date, decision, who answered, why, source). Never invent an
   answer. Remove answered items from Open questions.
3. **Plan locally:** refresh the local draft (`/speckit-sf-clarify`, then `/speckit-sf-plan`) under
   `.specify/specs/NNN-slug/`. Check it lists reuse decisions (existing objects/flows/classes found in `dev`), the
   blast radius and the security model.
4. **Org snapshot (C4):** for every object the feature touches, read `dev`: `sf sobject describe --sobject <X>
   --target-org dev` (fields, types, required, picklists), flows and triggers on it
   (`sf data query -q "SELECT ApiName, ProcessType, TriggerObjectOrEventLabel FROM FlowDefinitionView WHERE ..."
   --target-org dev`), permission sets granting it. Create or update the child page "Org snapshot: NNN slug" with
   a table per object (marking what the feature adds or changes) and the date and org alias of the snapshot.
5. **Diagram:** with the Lucid MCP, create or update "NNN-slug architecture": objects and relationships, automation
   (flows, triggers, handlers), LWCs, integrations, personas and their access. Put the link in the Diagram section.
6. **Update the design page** (`updateConfluenceContent`, from the version you just read): Technical plan, Data model
   (new/changed objects and fields with types, FLS, record types), Security model, Diagram, Risks, and the story
   outline (Story 00 foundation first, then feature stories with acceptance criteria). Keep Decisions as written by
   `record-decision`.
7. **Status:** set the page status to "Ready for review" (`setConfluenceContentStatus`). Never "Approved".
8. **Hand over (G1):** "Review the design page and the org snapshot. If you approve, follow `arch-approve-design`:
   only an `architects` member sets the status to Approved and records the version on the epic." Then: after G1,
   run `arch-jira-push NNN-slug`.
