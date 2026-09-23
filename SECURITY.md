# Security

Openfield runs on your computer and holds your API keys, so we take reports seriously.

## Reporting a problem

Please don't open a public issue. Report it privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**. GitHub's guide to [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) walks through it.

Include what you found, how to reproduce it, the commit you tested, and what an attacker could do with it. Please don't include a real key. We'll confirm we got the report, keep you posted while we fix it, and credit you in the release notes unless you'd rather not be named.

Fixes land on the `main` branch and in the latest release.

## Scope

We especially want to hear about:

- **Key handling.** A key readable outside `config.json`, written to logs, the database, an error, an HTTP response or an event stream, or shipped in the browser bundle.
- **The local server guards.** Any way a web page or another site can read data from the server or make it act: getting past the Host check, the cross-site checks or the session token, or a CORS header appearing anywhere.
- **File serving.** Reading or writing files outside the Openfield folder through `/files`, uploads, imports or exports, or making the server generate files it shouldn't.
- **Outbound requests.** Making the server contact a host its adapters don't declare, follow a redirect to another host, or use plain `http:`.
- **Imports.** A preset, canvas or image file that runs code or escapes the Openfield folder when imported.

Out of scope:

- Anything that already needs access to your user account. Someone who can read your home folder can read your keys, by design.
- Other programs on the same computer. While Openfield runs, anything on this computer that can reach `127.0.0.1` can load the app and use it like you do, including other user accounts. The guards stop web pages, not local programs. On a shared computer, stop Openfield when you're not using it. Openfield never lets the app choose a program to run, so this doesn't give anyone a way to run commands as you.
- Problems in a company's own API or website. Report those to the company.
- Vulnerabilities in a dependency with no path to exploit them through Openfield. Report those upstream, and tell us if Openfield is affected.

## How Openfield protects your keys

- Keys are saved in `~/.openfield/config.json`, readable only by your user account (mode `0600`, folder `0700`). Openfield checks and fixes the permissions at every start.
- Keys set through environment variables override the file and are never written to disk.
- The server makes every call to the model. Keys never reach the browser, and the API only reports whether a key is set and its last four characters.
- Logs and the Error log drop auth headers and replace any known key with `[hidden]`, with key-shaped patterns as a second net.
- The server listens on `127.0.0.1` only. Every request must pass a Host check, a cross-site check and a per-start session token, and the server never sends CORS headers. These stop other websites, not other programs on your computer (see Scope).
- The server only connects to the hosts each adapter declares, over `https:`, and doesn't follow redirects to other hosts.
- CI builds the web app and fails if server code or a key-shaped string ends up in the browser bundle.
- There is no telemetry. The only outbound traffic is the model calls you start.
