## Orphan Remediation

Notes gain value through connections over time.

### Orphan Detection
- Every new note should link TO at least one existing concept
- Every note should be linked FROM at least one other note
- Orphans older than 7 days deserve attention
- New notes can exist without links temporarily - connections emerge naturally

### Workflow
1. Use `orphans` to find isolated notes older than 7 days
2. For each orphan:
   - Find related concepts with `find_related`
   - Add outbound links to relevant concepts mentioned in the content
   - If truly unconnected to anything, consider deletion
