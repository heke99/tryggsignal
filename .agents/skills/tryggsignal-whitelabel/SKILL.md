---
name: tryggsignal-whitelabel
description: "Use for Tryggsignal wildcard municipality subdomains, custom domains, branding, tenant discovery, tenant routing, SSO callbacks, cookies and white-label configuration."
metadata:
  short-description: "Tryggsignal project skill"
---

# Tryggsignal White-label and Tenant Routing

Supported domains:
- `tryggsignal.se` public site
- `app.tryggsignal.se` central gateway
- `kommuner.tryggsignal.se` municipality discovery
- `<kommun>.tryggsignal.se` standard municipality host
- verified custom domain such as `samhallsbyggnad.mjolby.se`

Resolve every request: normalized verified hostname → active domain record → tenant → assigned environment/data plane → tenant auth config → authorization → branding. Reject unknown, disabled, ambiguous or unverified domains. Never let a client-supplied tenant id override hostname/session binding.

White-label includes logo/favicon, design tokens, product/portal labels, support/legal links, email/document branding and optional Tryggsignal attribution. Do not allow arbitrary tenant JavaScript, arbitrary HTML or unrestricted CSS injection. Validate contrast/accessibility for tenant themes.

Sessions should be host-bound unless a deliberately designed central-login handoff is used. Avoid `.tryggsignal.se` broad auth cookies that could create cross-municipality confusion. Custom-domain activation requires ownership/DNS, TLS, tenant resolution, auth callback and isolation tests before ACTIVE. Cache keys must include verified tenant/domain scope.
