# Team Review

The project menu's **团队审片** entry publishes an already exported MP4 as a fixed review version. Publishing captures the render ID, project revision, duration and frame rate. Further project edits and later exports do not change that review video. Each publication has separate named participants and timecoded discussion threads.

The director can create reviewer or view-only invitations, copy their links, revoke access, reply, edit comments, and resolve or reopen threads. Reviewers can add comments and replies and edit or resolve their own threads. View-only participants can watch and download the authorized video and read the discussion. Creating an invitation does not send messages to anyone.

Comment authors come from authenticated invitations. Clients cannot submit a different author. New comments accept idempotent request IDs; edits require the current comment version and return a structured conflict with the latest comment when it has changed. Discussion changes are polled every three seconds. Timecode links seek and pause the exact video time.

## Service Boundaries

The authoring editor and its full MCP endpoint remain bound to localhost. A separate review HTTP service exposes only review login, the authorized publication, its video, its comments and a restricted MCP catalog. It has no project editing, asset library, full MCP token or owner administration endpoints.

The review listener starts with `npm run dev` or `npm start`. Its default port is the authoring API port plus 100, normally `http://127.0.0.1:4273`. The API prints both addresses at startup. During development, invitation links redirect to Vite's `review.html` entry; the production build contains a standalone review portal.

Configuration:

| Variable | Meaning |
| --- | --- |
| `WHITEFRAME_REVIEW_PORT` | Separate review listener port. |
| `WHITEFRAME_REVIEW_HOST` | Listener interface, default `127.0.0.1`. |
| `WHITEFRAME_REVIEW_URL` | Public HTTP(S) origin used in invitations and allowed browser origins. |

For access from other machines, configure the review listener and its public origin, with HTTPS provided by a reverse proxy when appropriate. The authoring API retains its localhost boundary. Do not expose the authoring API as an unauthenticated proxy route.

Invitation tokens are generated from 32 random bytes and stored only as SHA-256 hashes in SQLite. Links carry the token in the URL fragment, which the portal removes immediately after reading. Login exchanges it for an eight-hour HttpOnly, SameSite=Strict cookie restricted to `/review-api`. HTTPS origins also set Secure. Authenticated video requests support byte ranges, seeking, fullscreen and download. Revoking an invitation invalidates its cookies and bearer access; already downloaded files remain on the recipient's machine.

## MCP

The owner's existing MCP connection provides `review_list`, `review_publish`, `review_invite`, `review_revoke`, `review_comments`, `review_comment_add` and `review_comment_update`.

An invited AI connects to the separate review service's `/mcp` endpoint using the invitation token as a bearer credential. `review_get` returns only the authorized publication and discussion. Reviewers also discover `review_comment_add` and `review_comment_update`; view-only invitations do not discover those mutation tools. The server derives the authorized publication from the credential, not a client-provided project ID.

Review publications, hashed invitations, browser sessions, comments, resolution state and retry records use SQLite. Complete installation backups must include SQLite and its referenced video files consistently. Portable `.whiteframe` project packages currently contain project/history/assets/video data; review credentials and collaboration records remain installation-level data and are not included in those project packages.

## Verification

`tests/review-service.test.ts` exercises real HTTP and official MCP clients, immutable publication revisions, scope isolation, author spoof rejection, view-only restrictions, cross-origin rejection, retries, version conflicts, range streaming, cookie properties, revocation and SQLite reopening.

`tests/review.spec.ts` exports an actual MP4, publishes it through the editor, opens two independent invited browser contexts, verifies timecoded comments and director replies, resolves a thread, seeks its frame, downloads as a viewer and checks live revocation. Desktop and 390px mobile screenshots are inspected for both the editor dialog and standalone review portal.
