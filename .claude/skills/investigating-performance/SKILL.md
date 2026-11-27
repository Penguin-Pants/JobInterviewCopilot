---
name: investigating-performance
description: "Investigates a specific performance problem with measurement before optimization, identifies the dominant bottleneck, implements only evidence-backed changes, and compares before-and-after results. Use for slow requests, high latency, excessive CPU or memory, rendering delays, database bottlenecks, or resource growth. Use for a measured or suspected resource or latency problem, not generic functional bugs. Analyze by default; optimize only when authorized."
---

# Investigate a performance problem

Follow AGENTS.md authorization modes and decision checkpoints. Use for a measured or suspected resource or latency problem, not generic functional bugs. Analyze by default; optimize only when authorized.

Investigate this performance problem:

Resolve the requested problem from the user request and repository context; ask only if essential information is missing.

Measure before optimizing.

1. Define the affected workload and observable metric such as latency, throughput, CPU, memory, queries or render time.
2. Establish a reproducible baseline when practical.
3. Profile or instrument the relevant path and identify the dominant bottleneck from evidence.
4. Separate measured bottlenecks from plausible but unverified risks.
5. Prefer the smallest change that improves the measured bottleneck without changing required behavior.

Do not optimize code because it looks inefficient. Do not introduce caching, concurrency, batching or new infrastructure without evidence that it addresses the measured constraint.

Only implement changes with authorization. After a change, repeat the same measurement and compare before and after. Check for regressions in correctness and resource use.

Run `TWO-PASS REVIEW` on the implementation when code changes are made.

Report baseline, bottleneck evidence, change, after measurement, percentage or absolute improvement when measurable and remaining limits or unverified risks.
