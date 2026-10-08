# RMP instructor identity review — October 7, 2026

RMP ratings are updated manually. Course requests read the saved cache, and live
Atlas seat refreshes do not contact RMP. Reviewed profile overrides persist for
future manual rating refreshes.

## Scope and procedure

1. Inventory all 698 unlinked identities in the Fall 2026 and Spring 2027 cache:
   683 unmatched names and 15 uncertain matches. Retain the authoritative Atlas
   instructor ID, school, subjects, course names, and any captured email.
2. Search the complete, verified Emory and Oxford RMP directory export by first
   and last name. Middle initials, punctuation, accents, and compound surnames
   may produce review candidates; they never authorize a match automatically.
3. Divide the inventory into six disjoint groups for GPT-6.1 Sol subagents with
   High reasoning. Confirm candidate profile IDs, names, schools, and departments
   on public RMP pages. Compare the department with the Atlas teaching subjects
   and consult official university faculty pages when identity needs clarification.
   Search public RMP results for names whose directory lookup needs clarification.
   Individually search every remaining unlinked name, including those absent
   from both school directories. A former-university profile also needs official
   university teaching evidence, such as a faculty appointment or class schedule;
   graduate education alone does not establish a match.
4. Record a decision for every identity. Approve only an unambiguous person with
   the same first and last name and a reasonable department fit. Skip profiles
   that cannot be found, initials that cannot establish identity, multiple plausible
   people, incompatible departments, or unavailable source evidence.
5. Independently check proposed approvals and their public evidence. Store explicit
   profile mappings against the existing school-scoped Atlas instructor IDs in
   `scripts/rmp/overrides.json`; never rewrite IDs or loosen runtime matching.
   Update only approved cache entries using verified summaries and original capture
   timestamps. Preserve existing linked professors and all skipped entries.
6. Publish a complete decision audit, reconcile cache/report counts, run targeted
   rating tests, `npm test`, `npm run build`, and Desloppify from the repository root.
   Verify a rendered local HTTP preview in connected Brave.
7. Commit only review-related files, push to `main`, deploy the exact commit to
   the VPS, check service health and production rating responses, and visually
   verify representative approved profiles in Brave after live Atlas refresh.

## Acceptance criteria

- Every unlinked identity has an audited outcome; uncertain matches remain unlinked.
- Every new mapping has a numeric RMP ID, verified name/school, department evidence,
  and an explanation tied to its Atlas instructor ID.
- No review prose, credentials, or private data are collected from RMP.
- Existing linked records, unrelated workspace edits, and skipped identities remain intact.
- Tests, build, deployment, and production verification complete before handoff.

## Review outcome

All 698 previously unlinked identities were reviewed. The final audit approved
127 profiles (116 rated and 11 unrated), skipped 487 missing or unsupported
identities, and retained 84 uncertain identities. Only approved records changed.
The complete decision audit is saved in `data/rmp/identity-review-20261007.json`.
The cache now contains 688 rated profiles, 62 unrated profiles, 558 unmatched
identities, and 13 ambiguous identities across the same 1,321 Atlas identities.
