import { useCallback, useEffect } from "react";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import {
  extractMessageText,
  extractThinking,
  extractToolCalls,
  normalizeMessages,
  parseChatEvent,
  parseAgentEvent,
  formatToolOutput,
} from "../../lib/message-utils";
import { useArtifactStore, type ArtifactType } from "../../stores/artifact-store";
import { useChatStore, nextMsgId } from "../../stores/chat-store";
import { useCoworkStore, type TaskStatus } from "../../stores/cowork-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { useUIStore } from "../../stores/ui-store";
import { ChatInput } from "./ChatInput";
import { MessageList } from "./MessageList";

const ARTIFACT_TOOL_NAMES = new Set(["create_artifact", "create-artifact"]);
const PLAN_TOOL_NAMES = new Set(["plan"]);
const COMPLETE_TOOL_NAMES = new Set(["complete", "task_complete", "task-complete"]);

/** Tools that are too trivial/read-only to track as subtasks in the CoworkPanel. */
const SKIP_SUBTASK_TOOLS = new Set([
  "read",
  "read-file",
  "read_file",
  "ls",
  "list-directory",
  "list_directory",
  "find",
  "grep",
  "plan",
  "complete",
  "task_complete",
  "task-complete",
]);

export function ChatView() {
  const sessionKey = useChatStore((s) => s.sessionKey);
  const setMessages = useChatStore((s) => s.setMessages);
  const setLoading = useChatStore((s) => s.setLoading);
  const setError = useChatStore((s) => s.setError);
  const appendDelta = useChatStore((s) => s.appendDelta);
  const finalizeRun = useChatStore((s) => s.finalizeRun);
  const abortRun = useChatStore((s) => s.abortRun);
  const addToolCall = useChatStore((s) => s.addToolCall);
  const updateToolCallPartial = useChatStore((s) => s.updateToolCallPartial);
  const updateToolCallResult = useChatStore((s) => s.updateToolCallResult);
  const setToolPanelOpen = useUIStore((s) => s.setToolPanelOpen);
  const upsertArtifact = useArtifactStore((s) => s.upsertArtifact);
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);

  // Load chat history when connected and session key changes
  useEffect(() => {
    if (status !== "connected") return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    request("chat.history", { sessionKey, limit: 200 })
      .then((res: unknown) => {
        if (cancelled) return;
        const data = res as { messages?: unknown[] };
        if (data?.messages) {
          setMessages(normalizeMessages(data.messages));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("[chat] failed to load history:", err);
        setError(err instanceof Error ? err.message : "Failed to load history");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [status, sessionKey, request, setMessages, setLoading, setError]);

  // Handle chat events from gateway
  const handleChatEvent = useCallback(
    (payload: unknown) => {
      const evt = parseChatEvent(payload);
      if (!evt) return;

      switch (evt.state) {
        case "delta": {
          const text = extractMessageText(evt.message);
          appendDelta(evt.runId, text, evt.seq);
          break;
        }
        case "final": {
          const text = extractMessageText(evt.message);
          const thinking = extractThinking(evt.message);
          const toolCalls = extractToolCalls(evt.message);

          if (text || toolCalls.length > 0) {
            finalizeRun(evt.runId, {
              id: nextMsgId(),
              role: "assistant",
              content: text,
              timestamp: Date.now(),
              thinking: thinking || undefined,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            });
          } else {
            finalizeRun(evt.runId);
          }
          break;
        }
        case "error": {
          finalizeRun(evt.runId, {
            id: nextMsgId(),
            role: "assistant",
            content: evt.errorMessage ?? "An error occurred.",
            timestamp: Date.now(),
          });
          break;
        }
        case "aborted": {
          abortRun(evt.runId);
          break;
        }
      }
    },
    [appendDelta, finalizeRun, abortRun],
  );

  // Cowork task tracking
  const upsertTask = useCoworkStore((s) => s.upsertTask);
  const updateTaskStatus = useCoworkStore((s) => s.updateTaskStatus);

  // Handle agent events (tool execution streaming + lifecycle/cowork)
  const handleAgentEvent = useCallback(
    (payload: unknown) => {
      const evt = parseAgentEvent(payload);
      if (!evt) return;

      // Handle lifecycle events for cowork task tracking
      if (evt.stream === "lifecycle") {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
        const label = typeof evt.data?.label === "string" ? evt.data.label : evt.runId;
        const parentTaskId =
          typeof evt.data?.parentTaskId === "string" ? evt.data.parentTaskId : undefined;

        switch (phase) {
          case "start":
            upsertTask({
              id: evt.runId,
              parentId: parentTaskId,
              label,
              status: "running",
              startedAt: evt.ts,
            });
            break;
          case "end": {
            updateTaskStatus(evt.runId, "completed");
            // When the agent explicitly called `complete`, mark all remaining
            // pending plan tasks as completed (handles cases where label matching
            // in the complete tool handler didn't catch everything).
            const completedExplicitly = evt.data?.completedExplicitly === true;
            if (completedExplicitly) {
              const { tasks } = useCoworkStore.getState();
              for (const [taskId, task] of tasks) {
                if (taskId.startsWith("plan-") && task.status === "pending") {
                  updateTaskStatus(taskId, "completed");
                }
              }
            }
            break;
          }
          case "error":
            updateTaskStatus(
              evt.runId,
              "error",
              typeof evt.data?.error === "string" ? evt.data.error : undefined,
            );
            break;
        }
        return;
      }

      // Only process tool stream events below
      if (evt.stream !== "tool") return;

      const data = evt.data;
      const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
      const phase = typeof data.phase === "string" ? data.phase : "";
      const name = typeof data.name === "string" ? data.name : "tool";

      if (!toolCallId) return;

      switch (phase) {
        case "start": {
          addToolCall({
            id: toolCallId,
            name,
            args: data.args ?? {},
            status: "running",
            timestamp: evt.ts,
          });
          // Auto-open the tool panel
          setToolPanelOpen(true);
          // Auto-populate subtask from tool call (skip trivial/read-only tools)
          if (!SKIP_SUBTASK_TOOLS.has(name.toLowerCase())) {
            const toolArgs = data.args as Record<string, unknown> | undefined;
            const primaryParam =
              typeof toolArgs?.command === "string"
                ? toolArgs.command
                : typeof toolArgs?.file_path === "string"
                  ? toolArgs.file_path
                  : typeof toolArgs?.path === "string"
                    ? toolArgs.path
                    : typeof toolArgs?.query === "string"
                      ? toolArgs.query
                      : typeof toolArgs?.url === "string"
                        ? toolArgs.url
                        : "";
            const shortParam =
              typeof primaryParam === "string" && primaryParam.length > 60
                ? primaryParam.slice(0, 57) + "..."
                : primaryParam;
            upsertTask({
              id: `tool-${toolCallId}`,
              parentId: evt.runId,
              label: shortParam ? `${name}: ${shortParam}` : name,
              status: "running",
              startedAt: evt.ts,
            });
          }
          break;
        }
        case "update": {
          const partial = formatToolOutput(data.partialResult);
          if (partial) {
            updateToolCallPartial(toolCallId, partial);
          }
          break;
        }
        case "result": {
          const result = formatToolOutput(data.result) ?? "";
          const isError = data.isError === true;
          updateToolCallResult(toolCallId, result, isError ? "error" : "completed");
          // Update subtask status
          updateTaskStatus(`tool-${toolCallId}`, isError ? "error" : "completed");

          // Detect plan tool results and create structured tasks
          if (!isError && PLAN_TOOL_NAMES.has(name)) {
            try {
              const parsed = JSON.parse(result);
              const tasks = parsed?.tasks;
              if (Array.isArray(tasks)) {
                for (const t of tasks) {
                  if (typeof t.id === "string" && typeof t.label === "string") {
                    upsertTask({
                      id: `plan-${t.id}`,
                      parentId: typeof t.parent_id === "string" ? `plan-${t.parent_id}` : evt.runId,
                      label: t.label,
                      status: "pending",
                    });
                  }
                }
              }
            } catch {
              /* ignore parse errors */
            }
          }

          // Detect complete tool: mark all matching plan tasks as completed
          if (!isError && COMPLETE_TOOL_NAMES.has(name)) {
            try {
              const parsed = JSON.parse(result);
              const completedTasks = parsed?.tasks_completed;
              if (Array.isArray(completedTasks)) {
                // Mark matching plan tasks by label (fuzzy substring match)
                const { tasks } = useCoworkStore.getState();
                for (const [taskId, task] of tasks) {
                  if (!taskId.startsWith("plan-") || task.status === "completed") continue;
                  const labelLower = task.label.toLowerCase();
                  const matched = completedTasks.some(
                    (ct: unknown) =>
                      typeof ct === "string" &&
                      (labelLower.includes(ct.toLowerCase()) ||
                        ct.toLowerCase().includes(labelLower)),
                  );
                  if (matched) {
                    updateTaskStatus(taskId, "completed");
                  }
                }
              }
              // Also mark the parent run task as completed
              updateTaskStatus(evt.runId, "completed");
            } catch {
              /* ignore parse errors */
            }
          }

          // Detect create_artifact tool results and update artifact store
          if (!isError && ARTIFACT_TOOL_NAMES.has(name)) {
            // Try to get artifact info from the result JSON or from stored tool call args
            let artifactId = "";
            let artifactType: ArtifactType = "html";
            let artifactTitle = "Artifact";

            // Try parsing the result JSON (the tool returns { artifactId, type, title })
            try {
              const parsed = JSON.parse(result);
              if (typeof parsed?.artifactId === "string") artifactId = parsed.artifactId;
              if (typeof parsed?.type === "string") artifactType = parsed.type as ArtifactType;
              if (typeof parsed?.title === "string") artifactTitle = parsed.title;
            } catch {
              // Fall back to tool call args
              const stored = useChatStore.getState().toolCalls.find((tc) => tc.id === toolCallId);
              const args = (stored?.args ?? data.args) as Record<string, unknown> | undefined;
              if (args) {
                const identifier = typeof args.identifier === "string" ? args.identifier : "";
                artifactId = identifier.replace(/[^a-zA-Z0-9_-]/g, "_");
                if (typeof args.type === "string") artifactType = args.type as ArtifactType;
                if (typeof args.title === "string") artifactTitle = args.title;
              }
            }

            if (artifactId) {
              upsertArtifact({
                id: artifactId,
                type: artifactType,
                title: artifactTitle,
                version: 1,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              openArtifact(artifactId);
            }
          }
          break;
        }
      }
    },
    [
      addToolCall,
      updateToolCallPartial,
      updateToolCallResult,
      setToolPanelOpen,
      upsertArtifact,
      openArtifact,
      upsertTask,
      updateTaskStatus,
    ],
  );

  // Handle dedicated artifact events (broadcast by gateway when artifact stream events arrive)
  const handleArtifactEvent = useCallback(
    (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const data = payload as Record<string, unknown>;
      const artifactId = typeof data.artifactId === "string" ? data.artifactId : "";
      const type = typeof data.type === "string" ? (data.type as ArtifactType) : "html";
      const title = typeof data.title === "string" ? data.title : "Artifact";
      const version = typeof data.version === "number" ? data.version : 1;

      if (!artifactId) return;

      upsertArtifact({
        id: artifactId,
        type,
        title,
        version,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      openArtifact(artifactId);
      setToolPanelOpen(true);
    },
    [upsertArtifact, openArtifact, setToolPanelOpen],
  );

  useGatewayEvent("chat", handleChatEvent);
  useGatewayEvent("agent", handleAgentEvent);
  useGatewayEvent("artifact", handleArtifactEvent);

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <MessageList />

      {/* Input */}
      <ChatInput />
    </div>
  );
}
