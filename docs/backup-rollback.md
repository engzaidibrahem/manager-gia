# Local backup notes (2026-09-09T12:16:14.0910234+07:00)

- Branch: fix/core-available-capital-warehouse
- PGlite backup: .data/gia-shawarma.backup-20260909-121612 (if present)
- Do not reset DB. Migrations are additive only.
- Rollback: restore backup folder + git checkout previous commit.
