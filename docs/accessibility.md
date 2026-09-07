# Accessibility — P32

Legal basis: lagen om tillgänglighet till digital offentlig service (DOS-lagen),
which requires WCAG 2.1 AA (EN 301 549). Tryggsignal targets WCAG 2.2 AA.

## Built in

| Requirement          | How                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic structure   | Real `main`, `section`, `nav`, `h1`–`h2`, `dl`, `table` with `caption`, `th scope`                                                                                      |
| Keyboard access      | No custom focus traps; a skip link to `#huvudinnehall` is the first focusable element                                                                                   |
| Visible focus        | `:focus-visible` outline with a 3px accent ring, never removed                                                                                                          |
| Colour contrast      | Tenant themes are validated to 4.5:1 before a branding version may be published (`validateBranding`), enforced by the `branding_published_requires_contrast` constraint |
| Colour independence  | Status is always text, never colour alone                                                                                                                               |
| Language             | `<html lang="sv">`; tenant locale is part of the branding tokens                                                                                                        |
| Dark mode            | Tokens respond to `prefers-color-scheme`                                                                                                                                |
| Error identification | Rejected domains and unreadable cases render an explicit `role="status"` message with the reason                                                                        |

## Verified

- Contrast validation is unit-tested (`tests/unit/branding.test.ts`), including the
  rejection of a theme that fails AA.
- Markup review of every implemented page.

## Not yet verified

Screen-reader passes (NVDA/VoiceOver), automated axe runs in CI, zoom to 400 %,
and the citizen portal flows — the portal is not built. P32 stays `IN_PROGRESS`
until these run against real screens.
