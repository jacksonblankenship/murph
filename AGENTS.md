Guidance for AI coding agents working in this repository.

> **Source of truth:** This file is canonical. `CLAUDE.md` and `.github/copilot-instructions.md` are symlinks for tool compatibility.

---

## Project Overview

Clarity, correctness, and test coverage matter more than cleverness.

---

## Commands

| Command | Description |
|---------|-------------|
| `bun install` | Install project dependencies |
| `bun run start` | Run the production build from `dist/` |
| `bun run dev` | Run in development mode with file watching |
| `bun run build` | Compile TypeScript to `dist/` |
| `bun run typecheck` | Type-check without emitting files |
| `bun run lint` | Check code with Biome (linting + formatting) |
| `bun run lint:fix` | Auto-fix linting and formatting issues |
| `bun run format` | Format all files with Biome |
| `bun run test` | Run the test suite |
| `bun run test:watch` | Run tests in watch mode |
| `bun run test:coverage` | Run tests with coverage report |

---

## MCP Servers (Use These)

This project provides MCP servers that are **part of the execution environment**, not optional helpers.  
Agents are expected to use them to **inspect state, perform actions, and validate work** instead of reaching for ad-hoc tools, shell commands, or assumptions.

General rules:

- These MCP servers are here to **answer questions and perform actions**.
- If an MCP can do something directly, use it instead of simulating or approximating the behavior.
- Guessing, shelling out, or inventing workflows when an MCP exists is a failure mode.

### Context7

Use for **authoritative, current documentation** when correctness matters:

- Framework, platform, or library behavior
- APIs, configuration, schemas, or recommended patterns

Expectation:

- Use Context7 to resolve uncertainty about documented behavior.
- Prefer official documentation over assumptions or prior experience.

### Exa

Exa is the **source of truth for external knowledge and web-backed research**.

Use it when you need high-quality, up-to-date information that does **not** live in the codebase or internal systems:

- Current information about companies, products, APIs, or services
- Web research where freshness, credibility, or coverage matters
- Validating claims against real-world sources instead of guessing

Expectation:

- Use Exa for external lookup instead of relying on training data, memory, or assumptions.
- Prefer Exa-backed results over generic web knowledge or fabricated citations.
- If a question depends on the state of the world outside the repo, Exa is the correct tool.

---

## General Notes

- **Zod for all validation and type narrowing.** We use Zod 4, which has different APIs than Zod 3. See [zod.dev/llms.txt](https://zod.dev/llms.txt) for LLM-friendly docs.
- **Guard clauses over nested conditionals.** Prefer early returns.
- **Logger levels.** Use `Logger` from `@nestjs/common`. Available levels: `log`, `fatal`, `error`, `warn`, `debug`, `verbose`.

---

## Testing Rules (Non-Negotiable)

### Required

- Every **business rule or domain constraint** must have an explicit test
- Write tests first for new features when practical
- Use descriptive test names that state the rule being enforced

### Do

- Test business logic and transformations
- Test edge cases and error paths
- Test database constraints and transactions

### Do Not

- Test framework behavior
- Write tests only for coverage
- Mock so heavily that real behavior is lost

---

## Readability Rules

**Readability > performance. Always.**

This is a business backend, not a high-frequency system. If the code is hard to read, it is wrong.

### Required Practices

- Prefer clear, explicit code over clever one-liners
- Use intermediate variables with descriptive names
- Extract complex conditions into named booleans or functions
- Write code so the next person does not need to ask you what it does

### Documentation (Yes, This Matters)

**JSDoc is AWESOME. Use it.**

Well-written JSDoc turns code into self-explaining, navigable, IDE-friendly documentation. It reduces bugs, speeds up reviews, and makes refactors safer.

Required expectations:
- Public functions must have JSDoc
- Non-obvious internal functions should have JSDoc
- Document:
  - What the function does
  - Why it exists if that is not obvious
  - Parameters, return values, and edge cases
- Prefer JSDoc over comments sprinkled inside the function body

If a function is hard to describe in JSDoc, the function is probably doing too much.

### File Organization

- It is okay to create more files
- Split files when:
  - A file exceeds ~250 lines
  - Responsibilities are mixed
  - Code is shared across modules

Avoid:
- 5-line files
- Needing to open many files to understand one simple function