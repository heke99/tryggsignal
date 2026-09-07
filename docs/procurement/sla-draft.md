# SLA draft

Draft for negotiation with a pilot municipality. Numbers are proposals, not
commitments, until the pilot's load and support model are agreed.

| Item                                                | Proposal                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Service availability                                | 99.5 % monthly, measured on the municipality's own portal host, excluding planned maintenance |
| Planned maintenance                                 | Announced 5 working days in advance, outside 07:00–18:00 CET on working days                  |
| Support hours                                       | Working days 08:00–17:00 CET                                                                  |
| Severity 1 response (data exposure or service down) | 1 hour                                                                                        |
| Severity 2 response (major function unavailable)    | 4 working hours                                                                               |
| Severity 3/4 response                               | 2 working days                                                                                |
| RPO                                                 | 5 minutes with point-in-time recovery, 24 hours otherwise                                     |
| RTO                                                 | 2 hours for the database, 4 hours for documents                                               |
| Security patching                                   | Critical within 7 days, high within 30 days                                                   |
| Penetration test                                    | Annually, report shared with the municipality                                                 |
| Exit support                                        | Full export within 30 days of request, per `docs/procurement/exit-plan.md`                    |
| Data location                                       | Sweden (`eu-north-1`) for the database; EU region for web hosting                             |

Performance targets are the masterplan SLOs: p95 < 500 ms for a normal read,
< 700 ms for a simple mutation, < 1 s for search, and an initial workspace load
under 2 s. See `docs/performance.md` for what has actually been measured.
