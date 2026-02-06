---
name: review-github-comments
description: Pulls the latest GitHub comments on flagged code and critically evaluates whether the feedback represents a real issue, a non-issue, or a documentation gap. Use when triaging review comments or deciding what to fix, ignore, or explain.
---

When reviewing GitHub comments, always:

1. **Restate the concern**: Summarize what the commenter thinks is wrong, in plain language
2. **Evaluate validity**: Decide if this is:
   - A real bug or design flaw
   - A reasonable concern with tradeoffs
   - A misunderstanding or incorrect assumption
3. **Explain your reasoning**: Be blunt about _why_ it is or isn’t worth addressing
4. **Recommend next steps**:
   - Fix it (with a brief plan)
   - Leave it as-is (and why)
   - Add documentation or a clarifying comment (and what it should say)

Assume commenters may lack full context. Do not default to agreeing. Optimize for engineering correctness, not reviewer appeasement.
