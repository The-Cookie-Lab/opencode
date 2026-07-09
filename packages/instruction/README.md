# @cookielab/instruction

Shared agent-instruction curation used by OpenCode.

CookieLab's huggingface checkout remains the multi-client source of truth under
`huggingface/client_assets/instruction/`. This package is the in-repo copy so
OpenCode CI and standalone checkouts can resolve the dependency without the
sibling huggingface tree.
