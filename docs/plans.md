# Architectural Plans & Visual Canvases

The Plan surface enables you to decompose complex projects, migrations, and research goals into structured, phase-gated execution roadmaps before writing code or modifying notes.

---

## 1. What a Plan Contains

A Darjeeling Plan consists of:
- **Title & Intent**: The high-level objective and architectural rationale.
- **Ordered Phases**: Distinct milestones (e.g. *Phase 1: Foundation*, *Phase 2: Core Migration*, *Phase 3: Verification*).
- **Checklist Tasks**: Actionable items with file targets and verification criteria.

---

## 2. Exporting Plans to Your Vault

Darjeeling integrates your plans natively into Obsidian's knowledge graph:

### A. Markdown Note (Dataview Compatible)
Clicking **Export to Note** creates a Markdown document in your configured plans folder (e.g. `Plans/My Initiative.md`):
- Includes YAML frontmatter (`id`, `status`, `created`, `tags: [darjeeling-plan]`).
- Checkboxes format as standard Markdown task lists compatible with the Dataview community plugin:
```markdown
---
id: plan-9402
title: "Database Migration"
status: in-progress
---

# Database Migration

## Phase 1: Schema Design
- [x] Draft initial ERD in `docs/schema.md`
- [ ] Review foreign key constraints
```

### B. Interactive 2D Visual Canvas (`.canvas`)
Clicking **Export to Canvas** exports a native **Obsidian Canvas 1.0** file:
- Each phase is rendered as an interactive node card with color-coded borders.
- Flow arrows connect sequential phases from left to right.
- Double-clicking file reference nodes inside the canvas navigates directly to the referenced notes or source files.

---

## 3. Agent Hand-Off & Verification

Once a plan is designed:
1. **Copy Brief**: Copies a formatted agent prompt to your clipboard containing the plan structure, current task status, and instructions for the agent.
2. **Run Plan**: Dispatches the plan directly into an active Chat session. The agent is instructed to focus strictly on the current uncompleted phase and wait for verification before progressing to subsequent phases.

---

## 4. Conflict Handling & File Placement

- **Storage Location**: Configurable in **Settings > Darjeeling > Plans** (default: root or `Plans/`).
- **File Collisions**: If a note or `.canvas` file with the same title already exists, Darjeeling handles the collision cleanly by generating a numbered variant (e.g. `Plans/Database Migration 1.canvas`) or asking for confirmation to overwrite, ensuring prior plans are never overwritten accidentally.
