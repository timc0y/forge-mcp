# Cloudflare and free-compute opportunities for Forge

**Reviewed:** 16 July 2026
**Purpose:** identify lower-cost execution paths, Cloudflare-native improvements, and external free compute pools Forge can orchestrate before paying for Sandbox runtime.

## Executive conclusion

Forge should not be designed as "every task gets a container". It should be a policy router across progressively more expensive execution modes:

1. no compute: repository search, GitHub API, static reasoning;
2.
