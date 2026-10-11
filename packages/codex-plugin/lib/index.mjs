// packages/remote-sessions/src/types.ts
var MAX_COMMAND_ENTRIES = 256;
var MAX_REQUEST_ENTRIES = 256;
var REQUEST_RESULT_MAX_BYTES = 256 * 1024;
var DEFAULT_OPERATION_TIMEOUT_MS = 15e3;
function emptyJournal() {
  return { version: 1, commands: [], requests: [] };
}
var SessionRunnerError = class extends Error {
  code;
  constructor(code, message2) {
    super(message2);
    this.name = "SessionRunnerError";
    this.code = code;
  }
};

// packages/remote-sessions/src/protocol.ts
function invalid() {
  throw new SessionRunnerError("invalid_data", "Invalid remote-session protocol or journal data.");
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value) {
  if (!isObject(value)) return invalid();
  return value;
}
function keys(value, names) {
  if (Object.keys(value).some((key) => !names.includes(key))) invalid();
}
function rawText(value, max, min = 1) {
  if (typeof value !== "string" || value.length < min || value.length > max) return invalid();
  return value;
}
function text(value, max, min = 1) {
  if (typeof value !== "string") return invalid();
  return rawText(min > 0 ? value.trim() : value, max, min);
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
function boolean(value) {
  if (typeof value !== "boolean") return invalid();
  return value;
}
function nullable(value, parse) {
  return value === null ? null : parse(value);
}
function array(value, max, parse) {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value.map(parse);
}
function engine(value) {
  if (value !== "v1" && value !== "v2") return invalid();
  return value;
}
function status(value) {
  if (value !== "running" && value !== "waiting" && value !== "idle" && value !== "error") return invalid();
  return value;
}
function waiting(value) {
  if (value !== null && value !== "permission" && value !== "question") return invalid();
  return value;
}
function direction(value) {
  if (value !== "start" && value !== "end") return invalid();
  return value;
}
function messageId(value) {
  const id = rawText(value, 160);
  if (!/^msg_[a-zA-Z0-9]+$/.test(id)) return invalid();
  return id;
}
function stableMessageId(id) {
  return messageId(`msg_${id.replace(/[^a-zA-Z0-9]/g, "")}`);
}
function sessionIdForCommand(commandId) {
  const id = `ses_${text(commandId, 160).replace(/[^a-zA-Z0-9]/g, "")}`;
  if (!/^ses_[a-zA-Z0-9]+$/.test(id)) return invalid();
  return id;
}
function parseError(value) {
  const v = object(value);
  keys(v, ["code", "message"]);
  return { code: text(v.code, 60), message: text(v.message, 2e3) };
}
function model(value) {
  const v = object(value);
  keys(v, ["providerId", "modelId", "variant"]);
  return {
    providerId: text(v.providerId, 160),
    modelId: text(v.modelId, 160),
    ...v.variant === void 0 ? {} : { variant: nullable(v.variant, (value2) => text(value2, 60)) }
  };
}
function parseCommand(value) {
  const v = object(value);
  keys(v, ["commandId", "kind", "title", "prompt", "model", "expiresAt", "workspaceId"]);
  if (v.kind !== "remote_session_create") return invalid();
  const m = nullable(v.model, model);
  if (m !== null && m.variant === void 0) return invalid();
  return {
    commandId: text(v.commandId, 160),
    kind: "remote_session_create",
    title: text(v.title, 120),
    prompt: nullable(v.prompt, (value2) => rawText(value2, 1e5)),
    model: m === null ? null : { providerId: m.providerId, modelId: m.modelId, variant: m.variant ?? null },
    expiresAt: integer(v.expiresAt),
    ...v.workspaceId === void 0 ? {} : { workspaceId: nullable(v.workspaceId, (value2) => text(value2, 240)) }
  };
}
function parseReceipt(value) {
  const v = object(value);
  keys(v, ["sessionId", "workspaceId"]);
  return { sessionId: text(v.sessionId, 240), workspaceId: text(v.workspaceId, 240) };
}
function parseProgress(value) {
  const v = object(value);
  keys(v, ["status", "waitingFor", "engine", "model", "finalText", "error", "messageCount", "observedAt"]);
  return {
    status: status(v.status),
    observedAt: integer(v.observedAt),
    ...v.waitingFor === void 0 ? {} : { waitingFor: waiting(v.waitingFor) },
    ...v.engine === void 0 ? {} : { engine: engine(v.engine) },
    ...v.model === void 0 ? {} : { model: nullable(v.model, model) },
    ...v.finalText === void 0 ? {} : { finalText: text(v.finalText, 2e4, 0) },
    ...v.error === void 0 ? {} : { error: nullable(v.error, parseError) },
    ...v.messageCount === void 0 ? {} : { messageCount: integer(v.messageCount) }
  };
}
function parseComplete(value) {
  const v = object(value);
  if (v.status === "delivered") {
    keys(v, ["status", "sessionId", "workspaceId", "resultSummary"]);
    return {
      status: "delivered",
      ...parseReceipt({ sessionId: v.sessionId, workspaceId: v.workspaceId }),
      ...v.resultSummary === void 0 ? {} : { resultSummary: text(v.resultSummary, 4096, 0) }
    };
  }
  if (v.status !== "failed") return invalid();
  keys(v, ["status", "error", "resultSummary"]);
  return {
    status: "failed",
    error: parseError(v.error),
    ...v.resultSummary === void 0 ? {} : { resultSummary: text(v.resultSummary, 4096, 0) }
  };
}
function parseRequest(value) {
  const v = object(value);
  keys(v, ["requestId", "kind", "commandId", "sessionId", "workspaceId", "engine", "expiresAt", "action", "input"]);
  if (v.kind !== "remote_session_request") return invalid();
  const base = {
    requestId: text(v.requestId, 160),
    kind: "remote_session_request",
    commandId: text(v.commandId, 160),
    sessionId: text(v.sessionId, 240),
    workspaceId: text(v.workspaceId, 240),
    engine: nullable(v.engine, engine),
    expiresAt: integer(v.expiresAt)
  };
  const input = object(v.input);
  if (v.action === "read") {
    keys(input, ["from", "cursor", "limit"]);
    return { ...base, action: "read", input: {
      from: direction(input.from),
      cursor: nullable(input.cursor, (value2) => text(value2, 160)),
      limit: integer(input.limit, 1, 100)
    } };
  }
  if (v.action === "send") {
    keys(input, ["prompt", "messageId", "model"]);
    return { ...base, action: "send", input: {
      prompt: rawText(input.prompt, 1e5),
      messageId: nullable(input.messageId, messageId),
      model: nullable(input.model, model)
    } };
  }
  if (v.action !== "stop") return invalid();
  keys(input, ["messageId"]);
  return { ...base, action: "stop", input: { messageId: nullable(input.messageId, (value2) => text(value2, 160)) } };
}
function toolCall(value) {
  const v = object(value);
  keys(v, ["id", "name", "status", "input", "output", "error", "truncated"]);
  return {
    id: text(v.id, 240, 0),
    name: text(v.name, 240, 0),
    status: nullable(v.status, (value2) => text(value2, 60, 0)),
    input: nullable(v.input, (value2) => text(value2, 2e3, 0)),
    output: nullable(v.output, (value2) => text(value2, 2e3, 0)),
    error: nullable(v.error, (value2) => text(value2, 2e3, 0)),
    truncated: boolean(v.truncated)
  };
}
function message(value) {
  const v = object(value);
  keys(v, ["id", "role", "createdAt", "text", "truncated", "toolCalls", "error"]);
  if (v.role !== "user" && v.role !== "assistant") return invalid();
  return {
    id: text(v.id, 240, 0),
    role: v.role,
    createdAt: nullable(v.createdAt, integer),
    text: text(v.text, 2e4, 0),
    truncated: boolean(v.truncated),
    toolCalls: array(v.toolCalls, 200, toolCall),
    error: nullable(v.error, parseError)
  };
}
function parseReadResult(value) {
  const v = object(value);
  keys(v, ["title", "status", "waitingFor", "lastError", "messageCount", "from", "messages", "nextCursor", "historyScope"]);
  if (v.historyScope !== void 0 && v.historyScope !== "context" && v.historyScope !== "full") return invalid();
  return {
    title: nullable(v.title, (value2) => text(value2, 240, 0)),
    status: status(v.status),
    waitingFor: waiting(v.waitingFor),
    lastError: nullable(v.lastError, parseError),
    messageCount: integer(v.messageCount),
    from: direction(v.from),
    messages: array(v.messages, 100, message),
    nextCursor: nullable(v.nextCursor, (value2) => text(value2, 160, 0)),
    ...v.historyScope === void 0 ? {} : { historyScope: v.historyScope }
  };
}
function parseSendResult(value) {
  const v = object(value);
  keys(v, ["messageId", "alreadyPresent"]);
  return { messageId: nullable(v.messageId, (value2) => text(value2, 160, 0)), alreadyPresent: boolean(v.alreadyPresent) };
}
function parseStopResult(value) {
  const v = object(value);
  keys(v, ["stopped", "reason"]);
  if (v.reason !== null && v.reason !== "different_turn") return invalid();
  return { stopped: boolean(v.stopped), reason: v.reason };
}
function parseRequestComplete(value) {
  const v = object(value);
  if (v.status === "failed") {
    keys(v, ["status", "error"]);
    return { status: "failed", error: parseError(v.error) };
  }
  if (v.status !== "done") return invalid();
  keys(v, ["status", "outcome"]);
  const outcome = object(v.outcome);
  keys(outcome, ["action", "result"]);
  if (new TextEncoder().encode(JSON.stringify(outcome)).byteLength > REQUEST_RESULT_MAX_BYTES) return invalid();
  if (outcome.action === "read") return { status: "done", outcome: { action: "read", result: parseReadResult(outcome.result) } };
  if (outcome.action === "send") return { status: "done", outcome: { action: "send", result: parseSendResult(outcome.result) } };
  if (outcome.action === "stop") return { status: "done", outcome: { action: "stop", result: parseStopResult(outcome.result) } };
  return invalid();
}
function parseInventory(value) {
  const v = object(value);
  keys(v, ["computer", "workspaces"]);
  const c = object(v.computer);
  keys(c, ["label", "platform", "appVersion"]);
  if (c.platform !== "darwin" && c.platform !== "win32" && c.platform !== "linux") return invalid();
  return {
    computer: { label: text(c.label, 120), platform: c.platform, appVersion: text(c.appVersion, 80) },
    workspaces: array(v.workspaces, 50, (value2) => {
      const w = object(value2);
      keys(w, ["workspaceId", "name", "active", "engine", "defaultModel", "models"]);
      const m = nullable(w.defaultModel, model);
      if (m?.variant === null) return invalid();
      return {
        workspaceId: text(w.workspaceId, 240),
        name: text(w.name, 120),
        active: boolean(w.active),
        engine: engine(w.engine),
        defaultModel: m === null ? null : {
          providerId: m.providerId,
          modelId: m.modelId,
          ...m.variant === void 0 ? {} : { variant: m.variant }
        },
        models: array(w.models, 200, (value3) => {
          const m2 = object(value3);
          keys(m2, ["providerId", "modelId", "name"]);
          return { providerId: text(m2.providerId, 160), modelId: text(m2.modelId, 160), name: text(m2.name, 200) };
        })
      };
    })
  };
}
function parseTurn(value) {
  const t = object(value);
  keys(t, ["messageId", "baselineMessageCount", "seenActive"]);
  return { messageId: messageId(t.messageId), baselineMessageCount: nullable(t.baselineMessageCount, integer), seenActive: boolean(t.seenActive) };
}
function parseJournal(value) {
  const v = object(value);
  keys(v, ["version", "commands", "requests"]);
  if (v.version !== 1) return invalid();
  const journal = {
    version: 1,
    commands: array(v.commands, MAX_COMMAND_ENTRIES, (value2) => {
      const e = object(value2);
      keys(e, ["command", "creation", "sendReplay", "intendedSessionId", "lastObservedAt", "phase", "receipt", "promptMessageId", "turn", "lastMessageId", "completion", "completionAcknowledged", "progress", "reportedProgress"]);
      if (e.phase !== "prepared" && e.phase !== "created" && e.phase !== "delivered" && e.phase !== "failed") return invalid();
      const command = parseCommand(e.command);
      const legacyCreation = e.creation === void 0 && e.intendedSessionId === void 0;
      if (!legacyCreation && e.creation !== "idempotent" && e.creation !== "at_most_once") return invalid();
      const creation = e.creation === "idempotent" ? "idempotent" : "at_most_once";
      if (e.sendReplay !== void 0 && e.sendReplay !== "idempotent" && e.sendReplay !== "at_most_once") return invalid();
      const sendReplay = e.sendReplay === "idempotent" ? "idempotent" : "at_most_once";
      const intendedSessionId = legacyCreation ? sessionIdForCommand(command.commandId) : text(e.intendedSessionId, 240);
      if (intendedSessionId !== sessionIdForCommand(command.commandId)) return invalid();
      const receipt = nullable(e.receipt, parseReceipt);
      const completion = nullable(e.completion, parseComplete);
      const acknowledged = boolean(e.completionAcknowledged);
      const promptMessageId = nullable(e.promptMessageId, messageId);
      const turn = nullable(e.turn, parseTurn);
      const lastMessageId = nullable(e.lastMessageId, messageId);
      const progress = nullable(e.progress, parseProgress);
      const reportedProgress = nullable(e.reportedProgress, parseProgress);
      const previousTimes = [progress?.observedAt, reportedProgress?.observedAt].filter((value3) => value3 !== void 0);
      const lastObservedAt = e.lastObservedAt === void 0 ? previousTimes.length === 0 ? null : Math.max(...previousTimes) : nullable(e.lastObservedAt, integer);
      if ((progress || reportedProgress) && (lastObservedAt === null || previousTimes.some((time) => time > lastObservedAt))) return invalid();
      if (creation === "idempotent" && receipt && receipt.sessionId !== intendedSessionId) return invalid();
      if (promptMessageId !== (command.prompt === null ? null : stableMessageId(command.commandId))) return invalid();
      if (e.phase === "prepared" && receipt !== null || (e.phase === "created" || e.phase === "delivered") && receipt === null) return invalid();
      if (receipt && command.workspaceId && receipt.workspaceId !== command.workspaceId) return invalid();
      if (e.phase === "delivered" !== (completion?.status === "delivered") || e.phase === "failed" !== (completion?.status === "failed")) return invalid();
      if (acknowledged && completion === null) return invalid();
      if (completion?.status === "delivered" && (completion.sessionId !== receipt?.sessionId || completion.workspaceId !== receipt?.workspaceId)) return invalid();
      if ((turn || lastMessageId) && !receipt) return invalid();
      if (turn === null !== (lastMessageId === null) || turn && turn.messageId !== lastMessageId) return invalid();
      if (e.phase === "created" && lastMessageId !== null && lastMessageId !== promptMessageId) return invalid();
      if (e.phase === "delivered" && command.prompt !== null && lastMessageId === null) return invalid();
      if ((progress || reportedProgress) && e.phase !== "delivered") return invalid();
      return {
        command,
        creation,
        sendReplay,
        intendedSessionId,
        lastObservedAt,
        phase: e.phase,
        receipt,
        promptMessageId,
        turn,
        lastMessageId,
        completion,
        completionAcknowledged: acknowledged,
        progress,
        reportedProgress
      };
    }),
    requests: array(v.requests, MAX_REQUEST_ENTRIES, (value2) => {
      const e = object(value2);
      keys(e, ["request", "sendReplay", "messageId", "turn", "completion", "completionAcknowledged"]);
      const request = parseRequest(e.request);
      if (e.sendReplay !== void 0 && e.sendReplay !== "idempotent" && e.sendReplay !== "at_most_once") return invalid();
      const sendReplay = e.sendReplay === "idempotent" ? "idempotent" : "at_most_once";
      const id = nullable(e.messageId, (value3) => text(value3, 160));
      const turn = nullable(e.turn, parseTurn);
      if (turn && (request.action !== "send" || turn.messageId !== id)) return invalid();
      const completion = nullable(e.completion, parseRequestComplete);
      const acknowledged = boolean(e.completionAcknowledged);
      if (acknowledged && !completion) return invalid();
      if (completion?.status === "done" && completion.outcome.action !== request.action) return invalid();
      if (request.action === "read" && id !== null) return invalid();
      if (request.action === "send" && id !== (request.input.messageId ?? stableMessageId(request.requestId))) return invalid();
      if (request.action === "stop" && request.input.messageId !== null && id !== request.input.messageId) return invalid();
      return { request, sendReplay, messageId: id, turn, completion, completionAcknowledged: acknowledged };
    })
  };
  if (new Set(journal.commands.map((e) => e.command.commandId)).size !== journal.commands.length || new Set(journal.requests.map((e) => e.request.requestId)).size !== journal.requests.length) return invalid();
  const receipts = journal.commands.flatMap((e) => e.receipt ? [`${e.receipt.workspaceId}\0${e.receipt.sessionId}`] : []);
  if (new Set(receipts).size !== receipts.length) return invalid();
  const intendedIds = journal.commands.filter((e) => e.creation === "idempotent").map((e) => e.intendedSessionId);
  if (new Set(intendedIds).size !== intendedIds.length) return invalid();
  for (const e of journal.requests) {
    const c = journal.commands.find((c2) => c2.command.commandId === e.request.commandId);
    if (e.completion?.status === "failed") continue;
    if (c?.phase !== "delivered" || c.receipt?.sessionId !== e.request.sessionId || c.receipt.workspaceId !== e.request.workspaceId) return invalid();
  }
  return journal;
}

// packages/remote-sessions/src/timeout.ts
function throwIfAborted(signal) {
  if (signal.aborted) throw new DOMException("Remote-session operation cancelled.", "AbortError");
}
async function bounded(signal, timeoutMs, effect) {
  throwIfAborted(signal);
  const controller = new AbortController();
  let timer;
  let onAbort = () => {
  };
  const interrupted = new Promise((_resolve, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new DOMException("Remote-session operation cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new SessionRunnerError("operation_timeout", "Remote-session operation timed out; its outcome may be uncertain."));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      throwIfAborted(controller.signal);
      return effect(controller.signal);
    }), interrupted]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

// packages/remote-sessions/src/runner.ts
function failure(code, message2) {
  return { code, message: message2 };
}
function ambiguousSend(receipt) {
  return failure("ambiguous_send", `Native send may have been accepted in session ${receipt.sessionId}, workspace ${receipt.workspaceId}. Inspect that local session; this send will never be retried automatically.`);
}
function definitive(error) {
  if (!(error instanceof SessionRunnerError) || error.code === "operation_timeout" || error.code === "invalid_data") return null;
  return parseError({ code: error.code, message: error.message });
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function sameProgress(a, b) {
  if (!a) return false;
  const { observedAt: _a, ...left } = a;
  const { observedAt: _b, ...right } = b;
  return same(left, right);
}
function createSessionRunner(options) {
  const { adapter, store, transport } = options;
  const clock = options.now ?? Date.now;
  const now = () => integer(clock());
  const timeoutMs = integer(options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS, 1, 12e4);
  const creation = adapter.creation ?? "at_most_once";
  if (creation !== "idempotent" && creation !== "at_most_once") throw new SessionRunnerError("invalid_data", "Invalid adapter creation capability.");
  const canReplayCreation = (entry) => entry.creation === "idempotent" && creation === "idempotent";
  const sendReplay = adapter.sendReplay ?? "idempotent";
  if (sendReplay !== "idempotent" && sendReplay !== "at_most_once") throw new SessionRunnerError("invalid_data", "Invalid adapter send replay capability.");
  const canReplaySend = (entry) => entry.sendReplay === "idempotent" && sendReplay === "idempotent";
  let journal;
  let poisoned = false;
  let queue = Promise.resolve();
  function state() {
    if (!journal || poisoned) throw new SessionRunnerError("journal_unavailable", "Reload the runner from a valid durable journal before continuing.");
    return journal;
  }
  async function persist(next) {
    const validated = parseJournal(next);
    try {
      await store.save(structuredClone(validated));
    } catch (error) {
      poisoned = true;
      throw error;
    }
    journal = validated;
  }
  async function load() {
    if (poisoned) state();
    if (journal) return;
    try {
      journal = parseJournal(await store.load());
    } catch (error) {
      poisoned = true;
      throw error;
    }
    if (journal.commands.some((e) => e.phase === "prepared" && !canReplayCreation(e))) {
      await persist({ ...journal, commands: journal.commands.map((e) => e.phase !== "prepared" || canReplayCreation(e) ? e : {
        ...e,
        phase: "failed",
        completion: { status: "failed", error: failure(
          "ambiguous_creation",
          "Creation was interrupted before a receipt was saved. Inspect the native harness; this command will not create another session."
        ) }
      }) });
    }
    await recoverUnsafeSends();
  }
  async function recoverUnsafeSends() {
    const current = state();
    let changed = false;
    let commands = current.commands.map((e) => {
      if (e.phase !== "created" || !e.turn || !e.receipt || canReplaySend(e)) return e;
      changed = true;
      const completion = { status: "failed", error: ambiguousSend(e.receipt) };
      const recovered = { ...e, phase: "failed", completion };
      return recovered;
    });
    const requests = current.requests.map((e) => {
      if (e.completion || e.request.action !== "send" || !e.turn || canReplaySend(e)) return e;
      changed = true;
      const completion = { status: "failed", error: ambiguousSend(e.request) };
      commands = commands.map((c) => c.command.commandId === e.request.commandId && c.phase === "delivered" && c.lastMessageId !== e.messageId ? { ...c, turn: e.turn, lastMessageId: e.messageId, progress: null, reportedProgress: null } : c);
      return { ...e, completion };
    });
    if (changed) await persist({ ...current, commands, requests });
  }
  function serialized(operation) {
    const task = queue.then(async () => {
      await load();
      return operation();
    });
    queue = task.then(() => {
    }, () => {
    });
    return task;
  }
  function command(id) {
    const entry = state().commands.find((e) => e.command.commandId === id);
    if (!entry) throw new SessionRunnerError("unknown_command", "The command is not in this account's local journal.");
    return entry;
  }
  function request(id) {
    const entry = state().requests.find((e) => e.request.requestId === id);
    if (!entry) throw new SessionRunnerError("unknown_request", "The request is not in this account's local journal.");
    return entry;
  }
  async function saveCommand(entry) {
    await persist({ ...state(), commands: state().commands.map((e) => e.command.commandId === entry.command.commandId ? entry : e) });
  }
  async function saveRequest(entry) {
    await persist({ ...state(), requests: state().requests.map((e) => e.request.requestId === entry.request.requestId ? entry : e) });
  }
  function local(signal, effect) {
    return bounded(signal, timeoutMs, effect);
  }
  async function flushCommand(id, signal) {
    const e = command(id);
    if (!e.completion || e.completionAcknowledged) return;
    await local(signal, (s) => transport.complete(id, structuredClone(e.completion), s));
    await saveCommand({ ...command(id), completionAcknowledged: true });
  }
  async function flushRequest(id, signal) {
    const e = request(id);
    if (!e.completion || e.completionAcknowledged) return;
    await local(signal, (s) => transport.completeRequest(id, structuredClone(e.completion), s));
    await saveRequest({ ...request(id), completionAcknowledged: true });
  }
  async function createPrepared(id, signal, firstAttempt = false) {
    const entry = command(id);
    if (entry.phase !== "prepared") return;
    if (!firstAttempt && !canReplayCreation(entry)) {
      await saveCommand({ ...entry, phase: "failed", completion: { status: "failed", error: failure(
        "ambiguous_creation",
        "Creation was interrupted before a receipt was saved. Inspect the native harness; this command will not create another session."
      ) } });
      return;
    }
    throwIfAborted(signal);
    if (entry.command.expiresAt <= now()) {
      await saveCommand({ ...entry, phase: "failed", completion: {
        status: "failed",
        error: failure("expired", "The command expired before creation could be attempted or safely replayed.")
      } });
      return;
    }
    try {
      const receipt = parseReceipt(await local(signal, (s) => adapter.create(structuredClone(entry.command), s)));
      if (entry.command.workspaceId && receipt.workspaceId !== entry.command.workspaceId) {
        throw new SessionRunnerError("invalid_data", "The adapter created a session in a different workspace.");
      }
      if (entry.creation === "idempotent" && receipt.sessionId !== entry.intendedSessionId) {
        throw new SessionRunnerError("invalid_data", "Idempotent creation must return the journal's deterministic session ID.");
      }
      await saveCommand({ ...command(id), phase: "created", receipt });
    } catch (error) {
      if (signal.aborted) throw error;
      const proven = definitive(error);
      if (!proven) throw error;
      await saveCommand({ ...command(id), phase: "failed", completion: { status: "failed", error: proven } });
    }
  }
  async function deliver(id, signal) {
    let e = command(id);
    if (e.completion) return e.completion;
    if (e.turn && e.receipt && !canReplaySend(e)) {
      const completion2 = { status: "failed", error: ambiguousSend(e.receipt) };
      await saveCommand({ ...e, phase: "failed", completion: completion2 });
      return completion2;
    }
    if (e.command.expiresAt <= now()) {
      const completion2 = { status: "failed", error: failure("expired", "The command expired before its next native effect.") };
      await saveCommand({ ...e, phase: "failed", completion: completion2 });
      return completion2;
    }
    if (!e.receipt) throw new SessionRunnerError("ambiguous_creation", "A missing creation receipt cannot be replayed.");
    if (e.command.prompt !== null) {
      if (!e.turn) {
        const baseline = parseProgress(await local(signal, (s) => adapter.observe(structuredClone(e.receipt), s)));
        throwIfAborted(signal);
        await saveCommand({
          ...e,
          sendReplay: canReplaySend(e) ? "idempotent" : "at_most_once",
          turn: { messageId: e.promptMessageId, baselineMessageCount: baseline.messageCount ?? null, seenActive: false },
          lastMessageId: e.promptMessageId
        });
        e = command(id);
      }
      try {
        throwIfAborted(signal);
        if (e.command.expiresAt <= now()) return deliver(id, signal);
        const result = parseSendResult(await local(signal, (s) => adapter.send(structuredClone(e.receipt), {
          prompt: e.command.prompt,
          messageId: e.promptMessageId,
          model: structuredClone(e.command.model)
        }, s)));
        if (result.messageId !== null && result.messageId !== e.promptMessageId) {
          throw new SessionRunnerError("invalid_data", "The adapter returned a different stable message ID.");
        }
      } catch (error) {
        if (poisoned) throw error;
        const proven = definitive(error);
        const uncertain = proven?.code === "ambiguous_send" || !canReplaySend(e) && (signal.aborted || !proven);
        if (!uncertain && signal.aborted) throw error;
        if (!uncertain && !proven) throw error;
        const completion2 = { status: "failed", error: uncertain ? ambiguousSend(e.receipt) : proven };
        await saveCommand({ ...command(id), phase: "failed", completion: completion2 });
        throwIfAborted(signal);
        return completion2;
      }
    }
    const receipt = e.receipt;
    if (!receipt) throw new SessionRunnerError("invalid_data", "The delivered command has no receipt.");
    const completion = { status: "delivered", sessionId: receipt.sessionId, workspaceId: receipt.workspaceId };
    await saveCommand({ ...command(id), phase: "delivered", completion });
    return completion;
  }
  function knownReceipt(e) {
    return state().commands.find((c) => c.command.commandId === e.request.commandId && c.phase === "delivered" && c.receipt?.sessionId === e.request.sessionId && c.receipt.workspaceId === e.request.workspaceId);
  }
  async function performRequest(id, signal) {
    let e = request(id);
    if (e.completion) return e.completion;
    throwIfAborted(signal);
    let completion;
    let applyTurn = false;
    const c = knownReceipt(e);
    if (e.request.action === "send" && e.turn && !canReplaySend(e)) {
      completion = { status: "failed", error: ambiguousSend(e.request) };
      applyTurn = true;
    } else if (e.request.expiresAt <= now()) {
      completion = { status: "failed", error: failure("expired", "The request expired before its next native effect.") };
      applyTurn = e.turn !== null;
    } else if (!c?.receipt) completion = { status: "failed", error: failure("unknown_receipt", "Only a session delivered by this account's local journal can be controlled.") };
    else {
      const earlier = state().requests.slice(0, state().requests.findIndex((r) => r.request.requestId === id)).some((r) => r.request.commandId === e.request.commandId && r.request.action !== "read" && r.completion === null);
      if (earlier && e.request.action !== "read") throw new SessionRunnerError("request_in_progress", "An earlier native control request must be reconciled first.");
      try {
        if (e.request.action === "read") {
          const input = e.request.input;
          const result = parseReadResult(await local(signal, (s) => adapter.read(structuredClone(c.receipt), structuredClone(input), s)));
          completion = parseRequestComplete({ status: "done", outcome: { action: "read", result } });
        } else if (e.request.action === "send") {
          const input = e.request.input;
          if (!e.turn) {
            const baseline = parseProgress(await local(signal, (s) => adapter.observe(structuredClone(c.receipt), s)));
            throwIfAborted(signal);
            await saveRequest({
              ...e,
              sendReplay: canReplaySend(e) ? "idempotent" : "at_most_once",
              turn: { messageId: e.messageId, baselineMessageCount: baseline.messageCount ?? null, seenActive: false }
            });
            e = request(id);
          }
          throwIfAborted(signal);
          if (e.request.expiresAt <= now()) return performRequest(id, signal);
          const result = parseSendResult(await local(signal, (s) => adapter.send(structuredClone(c.receipt), {
            ...structuredClone(input),
            messageId: e.messageId
          }, s)));
          if (result.messageId !== null && result.messageId !== e.messageId) throw new SessionRunnerError("invalid_data", "The adapter returned a different stable message ID.");
          completion = { status: "done", outcome: { action: "send", result } };
          applyTurn = true;
        } else if (e.request.input.messageId === null && e.messageId !== null && c.lastMessageId !== e.messageId) {
          completion = { status: "done", outcome: { action: "stop", result: { stopped: false, reason: "different_turn" } } };
        } else if (e.messageId === null) {
          completion = { status: "done", outcome: { action: "stop", result: { stopped: false, reason: null } } };
        } else {
          const result = parseStopResult(await local(signal, (s) => adapter.stop(structuredClone(c.receipt), { messageId: e.messageId }, s)));
          completion = { status: "done", outcome: { action: "stop", result } };
        }
      } catch (error) {
        if (poisoned) throw error;
        const latest = request(id);
        const proven = definitive(error);
        const uncertainSend = latest.request.action === "send" && latest.turn !== null && (proven?.code === "ambiguous_send" || !canReplaySend(latest) && (signal.aborted || !proven));
        if (uncertainSend) {
          completion = { status: "failed", error: ambiguousSend(latest.request) };
          applyTurn = true;
        } else {
          if (signal.aborted) throw error;
          if (!proven) throw error;
          completion = { status: "failed", error: proven };
        }
      }
    }
    e = request(id);
    const updatedCommand = applyTurn && c && e.turn && c.lastMessageId !== e.messageId ? {
      ...command(c.command.commandId),
      turn: e.turn,
      lastMessageId: e.messageId,
      progress: null,
      reportedProgress: null
    } : null;
    await persist({
      ...state(),
      requests: state().requests.map((r) => r.request.requestId === id ? { ...e, completion } : r),
      commands: state().commands.map((c2) => updatedCommand && c2.command.commandId === updatedCommand.command.commandId ? updatedCommand : c2)
    });
    throwIfAborted(signal);
    return completion;
  }
  async function flushProgress(id, progress, signal) {
    try {
      await local(signal, (s) => transport.report(id, structuredClone(progress), s));
    } catch (error) {
      if (signal.aborted) throw error;
      if (typeof error !== "object" || error === null || !("status" in error) || error.status !== 404 && error.status !== 409) throw error;
      await saveCommand({ ...command(id), progress: null, reportedProgress: null });
      return false;
    }
    await saveCommand({ ...command(id), progress: null, reportedProgress: progress });
    return true;
  }
  async function watch(id, signal) {
    let e = command(id);
    if (e.phase !== "delivered" || !e.receipt || !e.completionAcknowledged) return;
    if (state().requests.some((r) => r.request.commandId === id && r.request.action === "send" && r.completion === null)) return;
    if (e.progress) {
      if (!await flushProgress(id, e.progress, signal)) return;
      e = command(id);
    }
    let progress = parseProgress(await local(signal, (s) => adapter.observe(structuredClone(e.receipt), s)));
    let turn = e.turn;
    if (turn) {
      const active = progress.status === "running" || progress.status === "waiting";
      if (active && !turn.seenActive) turn = { ...turn, seenActive: true };
      const knownCounts = turn.baselineMessageCount !== null && progress.messageCount !== void 0;
      const newMessages = turn.baselineMessageCount !== null && progress.messageCount !== void 0 && progress.messageCount >= turn.baselineMessageCount + 2;
      if (!active && !turn.seenActive && !newMessages) {
        progress = { ...progress, status: "running", waitingFor: null, finalText: "", error: null };
      } else if (!active && knownCounts && !newMessages) {
        progress = { ...progress, finalText: "" };
      }
    }
    if (progress.status === "running" || progress.status === "waiting") progress = { ...progress, finalText: "", error: null };
    if (!sameProgress(e.reportedProgress, progress)) {
      progress = { ...progress, observedAt: integer(Math.max(progress.observedAt, (e.lastObservedAt ?? -1) + 1)) };
      await saveCommand({ ...e, turn, progress, lastObservedAt: progress.observedAt });
      await flushProgress(id, progress, signal);
    } else if (!same(turn, e.turn)) await saveCommand({ ...e, turn });
  }
  return {
    accept(input, signal) {
      return serialized(async () => {
        throwIfAborted(signal);
        const value = parseCommand(input);
        const existing = state().commands.find((e) => e.command.commandId === value.commandId);
        if (existing && !same(existing.command, value)) throw new SessionRunnerError("command_conflict", "A command ID cannot be reused with different input.");
        if (!existing) {
          if (state().commands.length >= MAX_COMMAND_ENTRIES) throw new SessionRunnerError("journal_full", "Prune acknowledged commands before accepting more work.");
          const expired = value.expiresAt <= now();
          await persist({ ...state(), commands: [...state().commands, {
            command: value,
            creation,
            sendReplay,
            intendedSessionId: sessionIdForCommand(value.commandId),
            lastObservedAt: null,
            phase: expired ? "failed" : "prepared",
            receipt: null,
            promptMessageId: value.prompt === null ? null : stableMessageId(value.commandId),
            turn: null,
            lastMessageId: null,
            completion: expired ? { status: "failed", error: failure("expired", "The command expired before creation.") } : null,
            completionAcknowledged: false,
            progress: null,
            reportedProgress: null
          }] });
        }
        await createPrepared(value.commandId, signal, !existing);
        throwIfAborted(signal);
        const completion = await deliver(value.commandId, signal);
        await flushCommand(value.commandId, signal);
        return structuredClone(completion);
      });
    },
    execute(input, signal) {
      return serialized(async () => {
        throwIfAborted(signal);
        const value = parseRequest(input);
        const existing = state().requests.find((e) => e.request.requestId === value.requestId);
        if (existing && !same(existing.request, value)) throw new SessionRunnerError("request_conflict", "A request ID cannot be reused with different input.");
        if (!existing) {
          if (state().requests.length >= MAX_REQUEST_ENTRIES) throw new SessionRunnerError("journal_full", "Prune acknowledged requests before accepting more work.");
          const c = state().commands.find((c2) => c2.command.commandId === value.commandId && c2.phase === "delivered" && c2.receipt?.sessionId === value.sessionId && c2.receipt.workspaceId === value.workspaceId);
          let completion2 = !c ? { status: "failed", error: failure(
            "unknown_receipt",
            "Only a session delivered by this account's local journal can be controlled."
          ) } : null;
          const id = value.action === "send" ? value.input.messageId ?? stableMessageId(value.requestId) : value.action === "stop" ? value.input.messageId ?? c?.lastMessageId ?? null : null;
          if (c && value.action === "send") {
            const prior = state().requests.find((r) => r.request.commandId === value.commandId && r.messageId === id && r.request.action === "send");
            const original = c.promptMessageId === id ? { prompt: c.command.prompt, model: c.command.model } : null;
            const fingerprint = original ?? (prior?.request.action === "send" ? prior.request.input : null);
            if (fingerprint && !same({ prompt: fingerprint.prompt, model: fingerprint.model }, { prompt: value.input.prompt, model: value.input.model })) {
              completion2 = { status: "failed", error: failure("message_conflict", "A stable message ID cannot be reused with different prompt or model input.") };
            } else if (original || prior?.completion?.status === "done") {
              completion2 = { status: "done", outcome: { action: "send", result: { messageId: id, alreadyPresent: true } } };
            }
          }
          await persist({ ...state(), requests: [...state().requests, { request: value, sendReplay, messageId: id, turn: null, completion: completion2, completionAcknowledged: false }] });
        }
        const completion = await performRequest(value.requestId, signal);
        await flushRequest(value.requestId, signal);
        return structuredClone(completion);
      });
    },
    reconcile(signal) {
      return serialized(async () => {
        throwIfAborted(signal);
        let firstError;
        const attempt = async (operation) => {
          throwIfAborted(signal);
          try {
            await operation();
          } catch (error) {
            if (signal.aborted || poisoned) throw error;
            firstError ??= error;
          }
        };
        for (const e of state().commands) await attempt(async () => {
          await createPrepared(e.command.commandId, signal);
          await deliver(e.command.commandId, signal);
          await flushCommand(e.command.commandId, signal);
        });
        for (const e of state().requests) await attempt(async () => {
          await performRequest(e.request.requestId, signal);
          await flushRequest(e.request.requestId, signal);
        });
        for (const e of state().commands) await attempt(() => watch(e.command.commandId, signal));
        if (firstError !== void 0) throw firstError;
      });
    },
    inspect() {
      return serialized(async () => structuredClone(state()));
    },
    prune(pruneOptions = {}) {
      return serialized(async () => {
        const retainCommands = integer(pruneOptions.retainCommands ?? 128, 0, MAX_COMMAND_ENTRIES);
        const retainRequests = integer(pruneOptions.retainRequests ?? 128, 0, MAX_REQUEST_ENTRIES);
        const requests = [...state().requests];
        let toRemove = Math.max(0, requests.length - retainRequests);
        const retainedRequests = requests.filter((e) => {
          if (toRemove > 0 && e.completionAcknowledged && e.request.expiresAt <= now()) {
            toRemove--;
            return false;
          }
          return true;
        });
        toRemove = Math.max(0, state().commands.length - retainCommands);
        const commands = state().commands.filter((e) => {
          const terminal = e.phase === "failed" || e.reportedProgress?.status === "idle" || e.reportedProgress?.status === "error";
          if (toRemove > 0 && terminal && e.completionAcknowledged && e.progress === null && e.command.expiresAt <= now() && !retainedRequests.some((r) => r.request.commandId === e.command.commandId)) {
            toRemove--;
            return false;
          }
          return true;
        });
        await persist({ ...state(), commands, requests: retainedRequests });
        return structuredClone(state());
      });
    }
  };
}

// packages/remote-sessions/src/remote-client.ts
var RemoteSessionHttpError = class extends Error {
  status;
  constructor(status2) {
    super(`Remote-session HTTP request failed (${status2}).`);
    this.name = "RemoteSessionHttpError";
    this.status = status2;
  }
};
var MAX_RESPONSE_BYTES = 512 * 1024;
function safeBase(value) {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback) || url.username || url.password || url.search || url.hash) {
    throw new SessionRunnerError("unsafe_url", "Use HTTPS (or HTTP on loopback), without credentials, query, or fragment.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
async function smallJson(response, signal) {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new SessionRunnerError("invalid_response", "Remote-session response exceeds the size limit.");
  }
  if (!response.body) throw new SessionRunnerError("invalid_response", "Remote-session response has no JSON body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    for (; ; ) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new SessionRunnerError("invalid_response", "Remote-session response exceeds the size limit.");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    try {
      return JSON.parse(body);
    } catch {
      throw new SessionRunnerError("invalid_response", "Remote-session response is not valid JSON.");
    }
  } finally {
    await reader.cancel().catch(() => {
    });
    reader.releaseLock();
  }
}
function createRemoteSessionTransport(options) {
  const base = safeBase(options.baseUrl);
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeout = integer(options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS, 1, 12e4);
  const id = (value) => {
    const parsed = text(value, 160);
    if (parsed === "." || parsed === "..") throw new SessionRunnerError("invalid_data", "A route ID cannot be a dot segment.");
    return encodeURIComponent(parsed);
  };
  async function call(path, method, body, signal) {
    return bounded(signal, timeout, async (s) => {
      const token = options.token();
      if (!token || /[\r\n]/.test(token)) throw new SessionRunnerError("missing_token", "A current runner token is required.");
      const response = await fetcher(new URL(path, base), {
        method,
        redirect: "error",
        signal: s,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...body === void 0 ? {} : { "content-type": "application/json" } },
        ...body === void 0 ? {} : { body: JSON.stringify(body) }
      });
      if (response.redirected || response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new SessionRunnerError("redirect_refused", "Remote-session requests cannot follow redirects.");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new RemoteSessionHttpError(response.status);
      }
      return smallJson(response, s);
    });
  }
  return {
    async complete(commandId, body, signal) {
      const parsed = parseComplete(body);
      const response = object(await call(`v1/remote-session-commands/${id(commandId)}/complete`, "POST", parsed, signal));
      const c = object(response.command);
      if (c.id !== commandId || c.status !== parsed.status || (parsed.status === "delivered" ? c.sessionId !== parsed.sessionId || c.workspaceId !== parsed.workspaceId : c.sessionId !== null || c.workspaceId !== null)) throw new SessionRunnerError("invalid_response", "Command acknowledgement does not match the submitted result.");
    },
    async report(commandId, progress, signal) {
      const response = object(await call(`v1/remote-session-commands/${id(commandId)}/session`, "POST", parseProgress(progress), signal));
      if (response.ok !== true) throw new SessionRunnerError("invalid_response", "Progress acknowledgement is invalid.");
    },
    async completeRequest(requestId, body, signal) {
      const parsed = parseRequestComplete(body);
      const response = object(await call(`v1/remote-session-requests/${id(requestId)}/complete`, "POST", parsed, signal));
      const r = object(response.request);
      if (r.id !== requestId || r.status !== parsed.status) throw new SessionRunnerError("invalid_response", "Request acknowledgement does not match the submitted result.");
    },
    async claimCommand(commandId, signal) {
      const response = object(await call(`v1/remote-session-commands/${id(commandId)}/claim`, "POST", {}, signal));
      const value = parseCommand(response.assignment);
      if (value.commandId !== commandId) throw new SessionRunnerError("invalid_response", "Claimed command ID does not match.");
      return value;
    },
    async claimRequest(requestId, signal) {
      const response = object(await call(`v1/remote-session-requests/${id(requestId)}/claim`, "POST", {}, signal));
      const value = parseRequest(response.assignment);
      if (value.requestId !== requestId) throw new SessionRunnerError("invalid_response", "Claimed request ID does not match.");
      return value;
    },
    async pendingRequests(signal) {
      const response = object(await call("v1/remote-session-requests/pending", "GET", void 0, signal));
      return array(response.items, 5, (value) => {
        const item = object(value);
        if (item.kind !== "remote_session_request") throw new SessionRunnerError("invalid_response", "Unexpected pending work kind.");
        return { kind: "remote_session_request", requestId: text(item.requestId, 160) };
      });
    },
    async publishInventory(inventory, signal) {
      const response = object(await call("v1/automation-runner/inventory", "PUT", parseInventory(inventory), signal));
      if (response.ok !== true) throw new SessionRunnerError("invalid_response", "Inventory acknowledgement is invalid.");
      integer(response.updatedAt);
    }
  };
}
export {
  DEFAULT_OPERATION_TIMEOUT_MS,
  MAX_COMMAND_ENTRIES,
  MAX_REQUEST_ENTRIES,
  REQUEST_RESULT_MAX_BYTES,
  RemoteSessionHttpError,
  SessionRunnerError,
  createRemoteSessionTransport,
  createSessionRunner,
  emptyJournal,
  parseCommand,
  parseComplete,
  parseInventory,
  parseJournal,
  parseProgress,
  parseReadResult,
  parseReceipt,
  parseRequest,
  parseRequestComplete,
  parseSendResult,
  parseStopResult,
  sessionIdForCommand,
  stableMessageId
};
