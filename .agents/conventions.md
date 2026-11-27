# Engineering conventions

Version 2.1. Apply only relevant sections; project-specific approved decisions take precedence over generic defaults, never over safety constraints.

- Prefer feature-based organization, clear interfaces and one canonical source for data. Avoid duplicate state and needless abstraction.
- Use strict typing where available, validate external inputs and handle loading, empty, error, offline and timeout states. Never swallow errors; redact logs.
- Separate server and client state. Choose persistence based on data sensitivity and lifecycle. Use least privilege, established authentication, authorization at each trust boundary and parameterized queries.
- For user interfaces use semantic controls, keyboard access, visible focus, sufficient contrast and reduced-motion support. Test critical journeys manually. Target applicable WCAG AA.
- Pin runtime versions and commit lockfiles where appropriate. Add stack-specific lint, format, type checks, tests and build to CI. Prefer fast local checks and repeatable validation. Do not hardcode a stack or force telemetry.
- Measure performance before optimization. Set project-specific budgets. Document migrations, backup and recovery where relevant. No production changes without authorization.
- Keep README, architecture and decisions current. Comments explain why. Record deferred work with evidence and priority.
