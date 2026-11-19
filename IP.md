# IP records

Evidence of authorship, registered through iptrust.org (hash-only: content and blinding value never left the machine).
A record is evidence that this exact content existed by the time of the anchoring blocks and that the signer made the
statement; it is not a registered right.

| Date | Covers | Type | Record hash (lookup) | Signer | Git tag |
|---|---|---|---|---|---|
| 2026-11-18 | node-to-rust-migration-lab at commit 754359b: Node.js and Rust/Axum backends on MongoDB, gateway with rollback, migration-verification harness, benchmarks and reports (original work; excludes third-party dependencies) | software | [53baa71cd6f550e9550eca50f406c9b68b30842d053848938f7a7b1d8cf0371d](https://iptrust.org/v/53baa71cd6f550e9550eca50f406c9b68b30842d053848938f7a7b1d8cf0371d) | Gregory J. Ward | `ip-2026-11-18` |
| 2026-11-19 | node-to-rust-migration-lab (extended) at commit c056e3f: adds shared validation vectors and unit tests, Node cluster and bcrypt benchmarks, a load sweep with per-component CPU accounting, revised reports and dashboard (original work; excludes third-party dependencies) | software | [b365e40ec903c944a560372089f60eac948d07119a9bca377562c2a777cc5411](https://iptrust.org/v/b365e40ec903c944a560372089f60eac948d07119a9bca377562c2a777cc5411) | Gregory J. Ward | `ip-2026-11-19` |

Authors: Gregory J. Ward. AI use (signed statement): human-led and human-directed; implementation drafted with AI coding assistance
under the authors' direction and accepted by them.

## Verify

Needs the private `.iptrust/v2/<recordHash>/` evidence folder (kept by the author, not in git) and the tagged tree:

```bash
git worktree add /tmp/at-tag-node-rust-migration <tag>          # ip-2026-11-18 or ip-2026-11-19
cp -r .iptrust /tmp/at-tag-node-rust-migration/
(cd /tmp/at-tag-node-rust-migration && iptrust2 verify <recordHash> --fetch-headers)   # expect: valid, content: matched
git worktree remove --force /tmp/at-tag-node-rust-migration
```

The tag marks the registered commit. Later commits (this file, follow-ups) are not part of the registered tree.
