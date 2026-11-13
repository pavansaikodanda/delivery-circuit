---
name: arch-design
description: Architect refines a feature's Confluence design page - answers open questions with the Architect and records them as decisions, refines the change table, data model, automation, UI, security and story outline, updates the Lucid diagram, and sets the page to "Ready for review" (never Approved). Use with a feature slug or the design page link.
---

# Architect: refine the design

Persona: **Architect**. Input: `$ARGUMENTS` = `<slug>` or the design page link. Layouts and tags: `circuit` skill.

1. **Read** the page (`searchConfluenceUsingCql` `label = "feature-<slug>"`, then `getConfluencePage`): body, version,
   status. If it is Approved, stop: say changes need the Architect to move it back first.
2. **Open questions:** go through them one by one with the user. Never invent an answer. Record each answer with
   `record-decision` (date, decision, who, why, source) and remove the question.
3. **Re-check the org** where an answer changes scope (same read-only `sf` queries as `circuit-intake`, DEV alias).
4. **Refine** in one page update based on the version you read:
   - Change table: every row tagged EXISTS / EXTEND / CHANGE / REBUILD / NEW, Type filled, Notes say what changes;
   - Data model (types, required, FLS, record types), Automation (order, bulk), UI, Security;
   - Story outline: Story 00 = shared data model and permissions, then stories small enough for a few days each,
     each listing its change rows and acceptance criteria (Given/When/Then).
5. **Diagram:** update the Lucid diagram to match the change table; keep the link in Diagram.
6. **Status:** when no open questions remain, set *Ready for review*. Never Approved.
7. **Report:** what changed, remaining questions, and "Next: the Architect reviews the page and sets it to Approved
   in Confluence; then `arch-jira-push <slug>`".
