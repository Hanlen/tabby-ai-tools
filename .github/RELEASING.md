# npm releases through GitHub OIDC

`publish.yml` publishes the verified `.tgz` attached to a stable GitHub Release. It does not rebuild the package and does not store an npm token.

The workflow checks the annotated tag, the exact commit's successful Linux/macOS/Windows branch and tag checks, the attachment's SHA-256, the reviewed release-note checksum, package identity, archive contents and existing registry integrity. It refuses version overwrites and moving `latest` backward. After publishing it waits for npm processing and compares the downloaded registry tarball with the GitHub attachment.

One-time npm trusted publisher configuration:

- Package: `tabby-ai-tools`
- Provider: GitHub Actions
- Organization/user: `Hanlen`
- Repository: `tabby-ai-tools`
- Workflow filename: `publish.yml`
- Environment: leave empty
- Allowed action: direct `npm publish`

The owner can configure this with `npm trust github tabby-ai-tools --repo=Hanlen/tabby-ai-tools --file=publish.yml --allow-publish --yes --browser=false`. npm may require one web/2FA verification for this binding. Do not change account/package 2FA policy or add an `NPM_TOKEN` secret. A new binding must complete its first successful publish within npm's activation window; see [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

For each release, complete the documented local package and artwork checks, push the branch, wait for the three-platform checks, then push an annotated version tag and wait for its checks. Create a **draft** GitHub Release with English notes and the verified npm tarball SHA-256; upload that exact `.tgz`, then publish the Release. The published event starts the OIDC workflow. Wait for the publish workflow and registry verification before reporting completion.

The workflow can also be dispatched with an existing tag. Its default is a dry run, which validates the release without sending a publish request. An already-published identical version is a verified no-op. A version accepted by npm but still processing must not be submitted again.
