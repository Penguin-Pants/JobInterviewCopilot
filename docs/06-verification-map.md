# Interview CoPilot — Verification Map

Version 1.0. **Hand-authored. This file is the input, not an output.**

## Why this file exists

The first version of `scripts/traceability.py` derived requirement-to-test
coverage by Cartesian product: every test listed on a task was credited to every
requirement that task traced. That let a requirement report full coverage while
no listed test actually exercised it. `FR-027` was the example found in review,
credited to six Dashboard tests, none of which checked profile creation,
switching, or the exactly-one-active rule.

This file replaces that inference with an explicit claim. One row per
requirement, naming the tests that actually prove it. The script validates the
rows, it does not generate them. Adding a requirement without a row fails CI.

**Rule for adding a row.** List a test only if it would fail when the requirement
is broken. A test that merely runs nearby code does not count.

| Requirement | Verified by |
|---|---|
| FR-001 | TC-001 |
| FR-002 | TC-005, TC-009, TC-120 |
| FR-003 | TC-084 |
| FR-004 | TC-090, TC-157, MW-05 |
| FR-005 | TC-004, TC-005, MW-01 |
| FR-006 | TC-006, TC-138 |
| FR-007 | TC-006, TC-120 |
| FR-008 | TC-138 |
| FR-009 | TC-148 |
| FR-020 | TC-030, TC-031 |
| FR-021 | TC-020, TC-121, TC-155 |
| FR-022 | TC-021 |
| FR-023 | TC-151, TC-152, TC-153, TC-154 |
| FR-024 | TC-154 |
| FR-025 | TC-025, TC-121, TC-154 |
| FR-026 | TC-024, TC-155 |
| FR-027 | TC-158 |
| FR-028 | TC-158 |
| FR-029 | TC-030, TC-033, TC-116 |
| FR-030 | TC-034, TC-035 |
| FR-031 | TC-030, TC-033, TC-109 |
| FR-032 | TC-120 |
| FR-033 | TC-031, TC-032 |
| FR-034 | TC-139 |
| FR-035 | TC-147 |
| FR-036 | TC-147 |
| FR-037 | TC-056, TC-151 |
| FR-038 | TC-154, TC-156 |
| FR-040 | TC-040, TC-043, MW-02, MW-03, MW-04, MW-12 |
| FR-041 | TC-040 |
| FR-042 | TC-040, TC-136 |
| FR-043 | TC-041, TC-042, TC-107, TC-137 |
| FR-044 | TC-043 |
| FR-045 | TC-044 |
| FR-046 | TC-045 |
| FR-047 | TC-050, TC-051, TC-052, TC-152, TC-153 |
| FR-048 | TC-050 |
| FR-049 | TC-055, TC-056, TC-057 |
| FR-050 | TC-033, TC-053, TC-080, TC-081, TC-082, TC-159 |
| FR-051 | TC-083 |
| FR-052 | TC-085 |
| FR-053 | TC-087, TC-088, MW-08 |
| FR-054 | TC-086, TC-134 |
| FR-055 | TC-084 |
| FR-060 | TC-060, TC-063 |
| FR-061 | TC-061, TC-062 |
| FR-062 | TC-064, TC-066, TC-067 |
| FR-063 | TC-065 |
| FR-064 | TC-072, TC-073, TC-074 |
| FR-065 | TC-075, TC-076, TC-077, TC-078 |
| FR-066 | TC-068, TC-071 |
| FR-067 | TC-067, TC-069, TC-070 |
| FR-068 | TC-079, TC-163 |
| FR-069 | TC-122, TC-160 |
| FR-070 | TC-100, TC-102 |
| FR-071 | TC-154, TC-156 |
| FR-072 | TC-091 |
| FR-073 | TC-090, TC-092 |
| FR-074 | TC-093, TC-094 |
| FR-075 | TC-095 |
| FR-076 | TC-096, MW-05 |
| FR-077 | TC-140 |
| FR-078 | TC-140, TC-141 |
| FR-079 | TC-149 |
| FR-080 | TC-120 |
| FR-081 | TC-005 |
| FR-082 | TC-036, MW-07 |
| FR-083 | TC-005, TC-117 |
| FR-084 | TC-035, TC-117, MW-08 |
| FR-085 | TC-116, TC-142 |
| FR-086 | TC-002, TC-003, TC-007, TC-008 |
| FR-087 | TC-120 |
| FR-088 | TC-104, TC-135 |
| FR-089 | TC-142 |
| FR-090 | TC-110 |
| FR-091 | TC-111 |
| FR-092 | TC-112, TC-115 |
| FR-093 | TC-113, TC-114 |
| FR-094 | TC-116, TC-146 |
| FR-100 | TC-054, TC-100, TC-101, TC-103, TC-143, TC-144, TC-162, MW-09 |
| FR-101 | TC-105, TC-106, TC-107, TC-123 |
| FR-102 | TC-110 |
| FR-103 | TC-108, TC-109, TC-125 |
| FR-104 | TC-101, TC-143 |
| FR-105 | TC-105, TC-106, MW-10 |
| FR-106 | TC-134 |
| FR-107 | TC-135, MW-10 |
| FR-108 | TC-135, MW-10 |
| FR-109 | TC-145 |
| FR-110 | TC-120 |
| NFR-001 | TC-133, MW-06, MW-13 |
| NFR-002 | TC-042, TC-137 |
| NFR-003 | TC-022, TC-023, TC-139 |
| NFR-004 | TC-131 |
| NFR-005 | TC-131 |
| NFR-006 | TC-001 |
| NFR-007 | TC-112 |
| NFR-008 | TC-132, TC-161 |
| NFR-009 | TC-130 |
| NFR-010 | TC-115, TC-124 |
| NFR-011 | TC-001, MW-01 |
| NFR-012 | TC-005, MW-01 |
| NFR-013 | TC-001 |
| NFR-014 | TC-120 |
| NFR-015 | TC-001 |
| NFR-016 | TC-146 |
| NFR-017 | TC-150, MW-11 |
