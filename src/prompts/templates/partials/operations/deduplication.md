## Deduplication Workflow

Before making changes, check for similar notes. If any note is >80% similar:

### Detection
1. Use `find_similar` when you notice conceptual overlap
2. Read both notes with `read_note`
3. Determine if they cover the same concept or related but distinct concepts

### Resolution
- **Same concept**: Use `merge_notes` to consolidate
  - Preserve the richer content
  - Combined content must flow naturally as ONE note
  - NO "merged from" markers or separators
- **Related but distinct**: Ensure they link to each other

### When Splitting
1. First use `find_similar` to check if the extracted concept already exists
2. If it does, link to the existing note instead of creating a duplicate
