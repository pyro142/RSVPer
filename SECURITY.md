# Security policy

RSVPer holds guest names and replies, so security reports are taken seriously,
even though this is a small side project.

## Reporting a vulnerability

**Please don't open a public issue.** Instead, report it privately through
GitHub:

1. Go to this repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and the impact you think it has.

Please give me a reasonable amount of time to fix it before you share it
publicly. This is maintained in spare time, so a first reply might take up to
two weeks. I'll credit you in the fix unless you'd prefer not to be named.

## Scope

In scope: the code in this repository, for example authentication or session
problems, ways to read or change another household's reply, guessing invite
codes faster than the documented limits, injection or XSS, and leaking guest data.

Out of scope: problems in Cloudflare's own platform (report those to Cloudflare),
denial of service against a single deployment, and issues that need someone to
already have the admin password or access to the Cloudflare account.

## Supported versions

Only the latest version on the `main` branch is supported. If you've deployed
your own copy, see "Updating your copy" in the README to get fixes.
