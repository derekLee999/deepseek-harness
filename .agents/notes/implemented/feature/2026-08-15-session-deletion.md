# Agent Note: Session Deletion

Status: implemented

English | [中文](2026-08-15-session-deletion.zh.md)

## Problem

Archiving a session only hides its row: the log and the workspace accounting slot stay local, and there is no product surface that removes a conversation's stored record at all. Users escalating from "hide it from my list" to "this conversation should stop existing on this machine" had no route, and the GUI shipped an archive action with no destructive peer.

The construction spec for this gap was settled in the [domain-KV/workspace design note](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md): a `SessionPersistence.delete` primitive, a `session-persistence/deleted` event at the storage commit point, and orchestration rules (no running targets, leaves-only by default, bottom-up recursion, idempotent rerun). This note records how that spec shipped.

## Decision

`workspace.deleteSession({ sessionId })` permanently deletes one session's stored log and prunes every local projection of it:

1. **Liveness check.** A live session whose turn is running (`agent.status === 'running'`) fails with `session-running` — deletion never kills a task; the caller waits for the turn to settle or cancels it first. A live session owned by a subagent activation (`origin: 'subagent'` or activation-registered) fails with `session-busy` — the gateway holds no teardown for activation-owned lifecycles. An idle live session the gateway itself created or resumed is torn down: the gateway composes cancel+dispose through the `AgentHandle` it retains per session id, never by asking storage to stop the loop. Retention covers every route that makes a session live — the gateway's own `ensureSession` and fork paths store their handles, and the shared remote agent resolver (`dsh-api-remotes` `createApiRemoteAgentResolver`) reports each cold resume's handle through its `onHandle` sink (it used to drop the handle, which stranded sessions resumed through generic entry points like `session.prompt`). The handle store is module-level and keyed by the root context (the `dsh-mcp-client` root-keyed reservation pattern): the gateway plugin hot-reloads while its agents — whose lifecycle effects live on the root fiber — keep running, so a store local to one gateway generation would strand every pre-reload opened session as undeletable.
2. **Descent check.** Any live session (`ctx.sessions`) or persisted header whose `parentSession` names the target — fork lineage or subagent lineage alike — fails the delete with `session-has-descendants` carrying the child ids. Only leaves are deletable; recursive deletion stays future work per the settled spec.
3. **Storage deletion.** `ctx.sessionPersistence.delete(id)` runs on the per-id write chain (serialized with in-flight appends, after awaiting a live session's disposal drain). Unknown ids reject; an un-materialized create intent is cancelled and resolves; the JSONL backend unlinks both physical encodings and removes the emptied session directory, and the SQLite backend deletes the `events` + `sessions` rows in one transaction. Strictly after the durable removal the coordinator emits `'session-persistence/deleted'(id)` — the notified commit point derived stores and the host stream use.
4. **Registry pruning.** `ctx.workspaceRegistry.deleteSession(id)` drops the id from every workspace record's session account (through the entity's write prune: `updatedAt` stamped, change emitted), from the registry-global archive set, and from the header/path indexes, all serialized on the registry operation chain. Unknown ids are an idempotent no-op, so rerunning after a crash converges.

Error codes `session-busy`, `session-running`, and `session-has-descendants` joined `RpcErrorDetailsMap` (and the wire discriminator); success returns `{ deleted: true }` with no projection — committed removals ride the host frames.

## Frame delivery

A live deletion's `session/disposed` already streams `host/session-removed`; a cold session — persisted but never attached during this host run — has no disposal edge to frame. The host stream therefore also subscribes `session-persistence/deleted` and pushes `host/session-removed`, so one commit point covers both deletion shapes (a live delete streams a harmless duplicate removal frame; client removal handling is idempotent). Workspace-account and archive-set updates ride the existing `host/workspace-changed` and `host/archived-sessions-changed` frames driven by `domain/changed`, exactly like archive and attach.

## Client convergence

`WorkspaceRuntime.deleteSession` is the workspaces-service verb behind the UI: it calls the RPC and, when the deleted id is the current selection, clears it into the New Session view state — releasing the staged scope instead of holding it behind the removed-row mask. Everything else converges through the frames: the sessions list mirror drops the row on `host/session-removed`, and the workspace manager replays account and archive-set frames over any in-flight `workspace.list` baseline. The delete confirmation stays open until the removed row has rendered out of the live `useSessions` projection (the frame is the commit notification), mirroring the Workspace delete dialog.

## Confirmation interaction

The session row menu gains a `删除会话` / `Delete session` entry below the archive row, carrying the same `IconTrashOutline16` + `danger` treatment as the Workspace delete row. It opens the browser-owned confirmation `Modal` ("将永久删除…本地会话记录与日志，此操作无法撤销"), which blocks duplicate submission while pending, keeps the error inline on failure, and never calls the RPC for Cancel/Escape/Close.

## Deviations from the settled spec

- **Endpoint namespace.** The spec named a `session.delete` endpoint written before the `workspace.*` RPC surface existed. Deletion mutates registry state (account + archive set) exactly like `workspace.archiveSession`, so it shipped as `workspace.deleteSession` for symmetry with its peer; the orchestration rules came from the spec unchanged.
- **Derived stores reconcile instead of subscribing.** The spec asked derived data to subscribe to `session-persistence/deleted`. `dsh-session-query-sqlite` already reconciles against `listSnapshots()` on every search and deletes index rows whose sessions vanished (with correct generation bumps); a second, subscription-side delete would duplicate that machinery and its cursor-generation bookkeeping. Going through the existing reconcile is the deliberate implementation instead.
- **No recursive flag yet.** The settled bottom-up recursion shipped only in the rejection direction (`session-has-descendants`); no caller needs recursive deletion today, and `recursive: true` stays future work.

## Alternatives considered

**Auto-cancel inside the persistence layer.** Rejected (as in the spec): cancel/dispose belongs to the caller, and the gateway composes it through its retained handles. The persistence primitive instead refuses live identities.

**Unary echo carries the removed row.** Rejected: `{ deleted: true }` plus the existing frame vocabulary is the same convergence the Workspace delete uses, and inventing a session-list echo would add a second session-removal path for clients to order against frames.

**A dedicated removal frame name for cold deletions.** Rejected: `host/session-removed` already owns "this row leaves every client list", and the persistence commit event gives it one uniform source for both shapes.

**Delete the storage artifact after pruning the registry.** Rejected: the destructive step goes first so a crash midway converges toward "storage gone, registry prunes an idempotent ghost" instead of a row pointing at a resurrected log.

**Dispose a running live session instead of refusing.** Rejected: a running turn is user work; deletion must never kill it mid-task. The refusal code (`session-running`) keeps the already-shipped cancel path as the only way to stop a task.

## Verification

Persistence coordinator tests pin the deleted event (and throwing-listener containment), live/reserved refusals, serialization, and the idempotent second delete; the shared backend contract pins permanent removal, unknown reruns, id re-creatability, and intent cancellation on memory, JSONL (both encodings), and SQLite. Registry tests pin account + archive pruning, no-op unknowns, and post-delete re-archive refusal. Apiproxy tests pin cold deletion with the removal frame, live teardown through the retained handle with account/archive frames, teardown retention for a session resumed through the remote resolver (the generic `session.prompt` path), the running refusal and the delete-once-idle recovery, the root-keyed store's per-application identity across gateway generations, `session-has-descendants` (live and persisted children), `session-busy` (activation-owned and handle-less live), and the `session-not-found` rerun; carrier tests pin the request/value schemas, the handler row, and the new error branch parses. Client runtime tests pin the RPC call, current-selection clearing, and error propagation; component tests pin the danger-styled menu row, the confirmation copy, pending-until-row-removed closing, and the failure/retry/cancel path. The keyless browser scenarios seed a cold session, confirm deletion through the row menu, and watch the row, the JSONL artifact, the archive set, and every workspace account stay gone across reload; a second scenario opens the conversation first (the host attaches its Agent) and deletes the now-live session through the same path, verifying the teardown-and-delete flow for opened sessions.

## Consequences

Deletion is destructive and local: the session header, its log, its workspace slot, and its archive membership are gone for good, with no restore path (matches the product copy). Deleting the current conversation clears into the New Session view. A running turn refuses deletion (`session-running`) until it settles or is cancelled, so deletion can never destroy in-flight work. A fork child or subagent child blocks its parent's deletion until the child goes first, which errs toward keeping lineage intact — recursive deletion is the future-work extension point. The gateway retains one `AgentHandle` per session it creates or resumes in the root-keyed store; any new gateway creation path must add its handle there too, and the store itself survives gateway hot reloads by design.