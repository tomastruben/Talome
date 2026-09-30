# Scoped backend workflow verification

Creator completion always creates fresh evidence from its private source snapshot. Native browser checks use fixtures. A separate `app-runtime` result states whether a supported real backend workflow was exercised. A missing `talome-runtime-probe.json` leaves this result explicitly skipped; it does not certify backend behavior.

The initial supported declaration is:

```json
{ "version": 1, "adapter": "stopwatch-v1" }
```

This adapter accepts only `server.py` and `stopwatch.py` that are byte-identical to the reviewed versions in `apps/stopwatch`. Unknown adapters, additional command fields, missing files, and modified service sources fail before execution. Supporting another backend requires reviewing and implementing a new adapter in core; a generated command or report cannot grant verification.

The trusted runner receives the exact reviewed bytes over stdin, copies only those two files to a private temporary directory, and starts isolated Python with a private home, working directory, and session file. It binds `127.0.0.1` on an ephemeral port. The environment excludes source `.env` files and credentials, isolated Python ignores user import configuration, and the bootstrap denies outbound networking, DNS, child commands, and file opens for writes outside disposable state. It does not copy dependency trees or workspace modules. No production service or application data is used.

Actual HTTP requests verify fresh state, rejected invalid actions, start, rename, advancing elapsed time, lap creation, pause stability, persisted state across process restart, safe recovery after restarting a running timer, and confirmed reset. The test clears only its disposable session. The process group has a 30-second bound and bounded output; normal success and failure stop the service and remove temporary state. A force-killed runner may leave a private temporary directory, but its service descendants are stopped.

Evidence binds the complete publishable source snapshot, native contract, reviewed backend bytes, and runner script hashes. Core reads the fresh process response, requires every workflow marker, rejects failures or changed hashes, and writes the accepted report outside the source directory. Existing generated reports are never read as evidence. The runtime result replaces the browser validator's placeholder so there is one `app-runtime` status.

This proves the supported backend HTTP workflow with disposable data. It does not verify Docker deployment, production connectivity, browser-to-service wiring, external UI, or arbitrary generated backend behavior. The isolation is a guardrail around reviewed code, not an OS security boundary against malicious processes running under the same user.
