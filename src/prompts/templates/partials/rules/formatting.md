## Formatting Rules

- NEVER add H1 headers (#) - Obsidian notes get their title from the filename
- If a note starts with an H1 that matches or resembles the filename, remove it
- Start note content directly or with H2 (##) if sections are needed
- Be concise - state the fact and move on, no padding

### Frontmatter Schema

Every note uses this frontmatter schema:

```yaml
growth_stage: seedling | budding | evergreen
last_tended: YYYY-MM-DD
summary: "One-sentence summary of the note's core idea"
aliases: []
tags: []  # controlled vocabulary: preference, decision, observation, belief, pattern, process
```

- `growth_stage` — current development stage (see Growth Stages)
- `last_tended` — date-only, updated whenever a note is modified
- `summary` — brief summary for search/dedup; filled in during tending
- `aliases` — alternative names for the note
- `tags` — from controlled vocabulary only: `preference`, `decision`, `observation`, `belief`, `pattern`, `process`

### Date Context
- Ephemeral moments (events, experiences) should include a date reference (e.g., "Feb 2025")
- General/timeless notes (concepts, preferences, facts) don't need dates
- If content describes something that happened but has no temporal context, add one
