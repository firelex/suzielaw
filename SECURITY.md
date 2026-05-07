# Security Policy

## Supported Versions

Security updates are provided for the current maintained release line only.

| Version | Supported |
| ------- | --------- |
| latest stable release | Yes |
| older releases | No, unless otherwise stated |

If you are using an older release, please upgrade before reporting a security issue unless the vulnerability also affects the latest stable version.

## Reporting a Vulnerability

Please report security vulnerabilities privately. Do not create a public GitHub issue for suspected security issues.

Send reports to:

**support@teamsuzie.com**

Please include as much detail as possible:

- A clear description of the issue
- Steps to reproduce it
- The affected version, commit or deployment environment
- Any proof of concept code, screenshots or logs
- The potential impact, especially where legal documents, client data, authentication, permissions or model outputs may be affected

## What Counts as a Security Issue

Examples of issues we want reported include:

- Unauthorised access to documents, projects, matters or workspaces
- Broken authentication or session handling
- Permission bypasses between users, organisations or matters
- Exposure of API keys, secrets, prompts, logs or uploaded documents
- Insecure file handling, including unsafe document parsing or path traversal
- Prompt injection that causes data leakage, tool misuse or permission bypass
- Server-side request forgery, remote code execution or dependency compromise
- Any issue that could affect confidentiality, integrity or availability of legal work product

Model quality issues, hallucinations and incorrect legal outputs should usually be reported as product or evaluation issues rather than security vulnerabilities, unless they cause a confidentiality breach, permission bypass, unsafe tool execution or other security impact.

## Response Process

We aim to acknowledge valid security reports within **5 working days**.

Where a report is accepted, we will:

1. Confirm the affected versions or components
2. Assess severity and likely impact
3. Work on a fix or mitigation
4. Credit the reporter where appropriate, unless anonymity is requested
5. Publish a security advisory if the issue affects released versions

Where a report is declined, we will explain why where it is safe to do so.

## Disclosure

Please give us reasonable time to investigate and fix confirmed vulnerabilities before public disclosure.

We ask that you do not:

- Access, modify or delete data that does not belong to you
- Exfiltrate documents, prompts, logs or credentials
- Perform denial of service testing without prior written permission
- Publicly disclose an unresolved vulnerability

## Legal Tech Specific Considerations

This project may be used with sensitive legal material. Security reports involving client documents, privileged material, matter metadata, user permissions or confidential prompts will be treated as high priority.

When testing, please use synthetic or public test data only. Do not upload real client documents or confidential legal material unless you are authorised to do so.

## Contact

Security contact: **support@teamsuzie.com**

For non-security bugs, feature requests or evaluation issues, please use the normal GitHub issue tracker.
