# Files, clipboard images and SSH transfers

Paste a screenshot or copied file directly into the AI Tools composer with **Ctrl+V** (**Cmd+V** on macOS), or drag files into it. Attachments appear inline above the input with their name, size and a remove button; pasted images show thumbnails. Click a thumbnail (or focus it and press Enter/Space) to open a larger image preview, sized to the window. Press Esc, use the close button or click the backdrop to close it and return focus to the thumbnail. Changing conversations or removing the attachment closes its preview. Plain text pastes normally.

For SSH uploads and downloads, ask the assistant to use the attachment tools with the exact connected native SSH terminal and an existing absolute upload parent directory (default `/tmp` on POSIX servers). The plugin creates a unique private subdirectory and never overwrites an existing project file. Downloads require the remote file's absolute path and are stored in the attachment cache. Query transfer status or request cancellation through the assistant; the target tab also shows Tabby's native progress bar. Integrity verification finishes before an operation reports success. Closing the sidebar does not stop a transfer.

Files stay in a private cache next to the Tabby configuration directory, under `tabby-agent-attachments`. Attachments are associated with the AI conversation; metadata survives restarts and **Remove attachment** deletes the local cached file. Completed remote uploads remain at their returned paths until explicitly removed on the remote machine. The latest 200 transfer receipts and request keys are retained. After restarting, unfinished operations are marked unknown; operations owned by another window are not resumed or cancelled by this window. Inspect the saved target/window before starting a new request. Restarting never resumes or repeats an upload automatically.

## One transfer, no model chunk relay

The assistant can call `attachment_list`, `attachment_upload`, `attachment_download`, `attachment_status` and `attachment_cancel`. One upload/download request starts a plugin-owned operation. The plugin streams all chunks, performs SHA-256 checks and returns metadata and a verified receipt. For long transfers, status queries observe the same operation; they do not advance the next chunk. File bytes and base64 are never tool-result text, and the plugin does not call a model merely to move data.

An upload accepts an attachment ID from the current conversation. Its optional `remotePath` means the **parent directory**, not an overwrite destination. A download accepts a remote absolute filename and saves into the plugin's cache; models cannot select arbitrary local write paths. Attachment transfers are not recorded/replayed as reusable workflow steps; transfer the file before starting a recording or alias. Both directions respect existing tool permissions and approval policy. Read-only mode disables transfers, including downloads that create local files.

Transport order is the existing connection's SFTP, independent SSH exec with raw byte streams, independent exec with base64, then framed base64 in a positively identified idle Shell. Only a missing capability permits fallback. Permission errors, full disks, checksum failures and ambiguous results do not bypass those checks by trying another transport. Independent channels reuse SSH authentication and jump-host handling, without X11, a separate login, a file panel or a remote Agent installation.

Where independent exec is available, SFTP uploads create their private directory with `umask 077` on that connection, avoiding a directory SETSTAT incompatibility in the host's russh 0.1.38. File contents still use SFTP. SFTP verifies uploads by streaming them back and comparing SHA-256. Downloads reread the source and compare metadata and digest before publishing the local cache entry. Exec and PTY modes require an existing POSIX Shell, `base64` where used, and `sha256sum` or `shasum`; no runtime is installed. Limits are 100 MiB per file, 20 MiB / 40 million pixels per composer image, and eight attachments / 200 MiB per conversation. Transfers have a two-minute timeout. Payload capture is separate from ordinary screen snapshots.

## Remote Codex and other terminal Agents

Independent SFTP/exec can upload while Codex keeps running. Copy the resulting path and give it to the intended Agent through its supported image/file input. Uploading a picture is not proof that the Agent attached or read it. This release does not automatically press Enter, alter a terminal draft, attach an image to an existing Codex conversation or send it to the sidebar model.

The target is the **outer SSH host and account**. Nested SSH, containers, switched users and Agent sandboxes may not see that path. Confirm access before reporting delivery. On servers without `/tmp`, choose an appropriate existing parent; exec/PTY fallbacks are POSIX-only.

The last PTY fallback requires the same live session, reliable recent Shell completion and exclusive input control. It refuses unknown Shell state and does not interrupt a running Codex, Claude, editor or other program. If it fails/cancels without a final frame, the receiver may still be waiting: inspect the terminal before releasing input or retrying. Payload is suppressed from AI reads and workflow records, but the terminal frontend or external recording can still contain transferred text.

Cancellation closes this operation's resources, not the shared SSH connection. A disconnect or missing publish acknowledgement can leave an **unknown** result; inspect the unique remote path before retrying. A verified receipt proves file integrity at transfer time, not deployment or Agent task success.

## Validation scope

Fixtures exercise byte-exact SFTP, real local POSIX exec and Linux PTY round trips, changing files, owner isolation, request deduplication and native progress contention. Local subprocess fixtures are not authenticated SSH network tests. Actual desktop/SSH evidence is recorded separately in `VALIDATION.md` and the release notes; tests make no paid model requests.
