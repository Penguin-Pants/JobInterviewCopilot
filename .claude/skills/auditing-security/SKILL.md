---
name: auditing-security
description: "Performs a stack-aware repository security audit using applicable OWASP and framework controls, with evidence-backed findings and severity. Use for source security reviews, vulnerability sweeps, pre-release audits, or targeted review of application, API, authentication, authorization, data, configuration, and trust boundaries. Use for security-specific vulnerabilities and trust boundaries, not a general quality audit. Analyze by default."
---

# Repository security audit

Follow AGENTS.md authorization modes and decision checkpoints. Use for security-specific vulnerabilities and trust boundaries, not a general quality audit. Analyze by default.

Audit the repository for security vulnerabilities. This is analysis only unless the user explicitly requests fixes.

Detect the technology stack and exposed attack surface first. Exclude generated dependencies and runtime data such as `node_modules`, `vendor` and storage directories unless they contain security-relevant project configuration.

Inspect applicable trust boundaries and risks, including:

- injection, command execution, path traversal and unsafe deserialization
- XSS, output encoding, CSRF, redirects, SSRF and unsafe uploads
- authentication, authorization, IDOR and insecure object or tenant access
- unsafe object binding or mass assignment where relevant
- secrets, sensitive data exposure, logging and production debug settings
- rate limiting, abuse controls, CORS and security headers
- dependency, configuration and framework-specific risks

Apply framework-specific checks only when the detected stack makes them relevant. Use applicable OWASP guidance as a reference rather than forcing irrelevant checklist items.

Run `TWO-PASS REVIEW` before finalizing findings.

For each confirmed finding, report:

- severity using the shared scale
- `path:line`
- vulnerability and affected trust boundary
- evidence
- realistic impact
- root-cause fix

Report possible risks separately with the evidence needed to verify them. Group confirmed findings by severity and include counts.

If fixes are requested, use `DECISION CHECKPOINT` before implementing audit findings.
