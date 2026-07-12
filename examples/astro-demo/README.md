# Astro acceptance fixture

The deployed acceptance test should clone a pinned public Astro fixture, bootstrap it, start `astro dev --host 0.0.0.0`, expose port 4321 and capture phone and desktop evidence. The fixture is external so this repository does not duplicate an application dependency graph.
