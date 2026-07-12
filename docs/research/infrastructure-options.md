# Infrastructure options

Cloudflare Sandbox is selected over raw Containers, Codespaces, GitHub Actions, Kubernetes and permanent VMs for the initial interactive workspace. Raw Containers are an implementation detail of Sandbox. Actions remain useful for deterministic CI; Codespaces remain a possible user-funded backend. Provider contracts preserve an escape path without implementing multiple schedulers now.
