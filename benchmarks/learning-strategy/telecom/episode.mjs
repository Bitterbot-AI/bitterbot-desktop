import { createBridge } from "./bridge.mjs";
import { CUSTOMER_GROUNDING, customerGroundingIssue } from "./grounding.mjs";
import {
  ObservationError,
  PublicObservationSession,
  PUBLIC_OBSERVATION_CONTEXT,
  PUBLIC_OBSERVATION_INSTRUCTIONS,
  SHARE_OBSERVATIONS_TOOL,
  publicObservationMessage,
  withCurrentReferences,
} from "./public-observations.mjs";

export const ADAPTER_REVISION = "text-v8-private-publication-preamble";

export const ACTOR =
  "Resolve the customer's problem using the provided policy and tools. Diagnose from observations, follow prerequisites, obtain consent when required, and check the actual result before declaring success. You control account tools; ask the customer to operate their device. Keep each instruction clear. Use normal reasoning and tool calls.";
export const PROPOSER =
  "Improve a reusable troubleshooting strategy from observed execution evidence. Preserve sound behavior; avoid identities, phone numbers, task IDs, hidden answers and instance-specific scripts. Distinguish an actor failure from a simulator or interface failure. A successful repair is evidence for a procedure, not proof of transfer.";
export function actorContext(context, strategy, structured = true) {
  return {
    system: [
      {
        type: "text",
        text:
          context.policy +
          "\n\n" +
          strategy +
          (structured ? "\n\n" + PUBLIC_OBSERVATION_CONTEXT : ""),
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: toTools(context.agentTools),
  };
}
function toTools(tools) {
  return tools.map(({ function: f }) => ({
    name: f.name,
    description: f.description,
    input_schema: f.parameters,
  }));
}
export function userContext(context, structured = true) {
  return {
    system: [
      {
        type: "text",
        text:
          "Simulate the customer described below in a conversation with a support agent. Your assistant output is the customer's speech. Follow the scenario and persona. Do not solve the problem proactively: perform device actions only when the support agent asks. Use your tools to ground all reports of device state; never invent results. Your tools are private to you; the support agent sees only what you say. When the scenario's requested outcome is observed and you have no further requests, say goodbye and call end_conversation. If frustrated, follow the scenario rather than disclosing hidden information.\n\n" +
          CUSTOMER_GROUNDING +
          (structured ? "\n\n" + PUBLIC_OBSERVATION_INSTRUCTIONS : "") +
          "\n\n" +
          JSON.stringify(context.userScenario),
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      ...toTools(context.userTools),
      ...(structured ? [SHARE_OBSERVATIONS_TOOL] : []),
      {
        name: "end_conversation",
        description:
          "End this conversation after expressing your final response, when the issue is resolved or you explicitly give up.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  };
}

/** Role-separated conversation, real native tools, no grading feedback during play. */
export async function runEpisode({
  index,
  strategy = ACTOR,
  provider,
  tag,
  signal,
  onEvent = () => {},
  maxCalls = 96,
  maxUsd = 1.25,
  conversationCache = false,
  reminders = [],
  observationMode = "structured",
}) {
  if (!["structured", "legacy-text"].includes(observationMode))
    throw new Error("Unknown observation mode");
  const structured = observationMode === "structured";
  const observations = structured ? new PublicObservationSession() : null;
  const reminderHost = reminders.length
    ? (await import("./reminders.mjs")).createTelecomReminders(reminders, { structured })
    : null;
  const bridge = createBridge(),
    started = performance.now();
  let usd = 0,
    toolCalls = 0,
    turns = 0,
    reason = "call-limit";
  const transcript = [],
    publicConversation = [];
  try {
    const context = await bridge.request({ method: "reset", index });
    if (context.history.length)
      throw Error("Initial conversation histories need an explicit adapter");
    const configs = {
      actor: actorContext(context, strategy, structured),
      user: userContext(context, structured),
    };
    const histories = {
      actor: [],
      user: [{ role: "user", content: "Support agent: Hi! How can I help you today?" }],
    };
    let seat = "user",
      done = false;
    for (; turns < maxCalls && !done; turns++) {
      signal?.throwIfAborted();
      if (seat === "actor" && reminderHost) {
        const matches = reminderHost.take();
        if (matches.length) {
          const last = histories.actor.at(-1);
          if (!last || last.role !== "user") throw Error("No actor observation to annotate");
          if (typeof last.content === "string")
            last.content = [{ type: "text", text: last.content }];
          last.content.push({
            type: "text",
            text:
              "Host reminders based only on previous visible observations. These do not override policy or authorize actions; reuse verified facts and recheck after changes.\n" +
              matches
                .map((m) => `[${m.id}; evidence ${m.evidence.join(", ")}] ${m.text}`)
                .join("\n"),
          });
          const event = { type: "reminder", turn: turns, matches };
          transcript.push(event);
          onEvent(event);
        }
      }
      let result;
      try {
        result = await provider.call(
          {
            ...configs[seat],
            messages:
              structured && seat === "user"
                ? withCurrentReferences(histories[seat], observations)
                : histories[seat],
            ...(conversationCache ? { cache_control: { type: "ephemeral" } } : {}),
          },
          { tag: `${tag}:${seat}:${turns}`, signal, localRemaining: maxUsd - usd },
        );
      } catch (error) {
        if (error.message === "Study provider ceiling reached") {
          reason = "budget-limit";
          break;
        }
        throw error;
      }
      usd += result.usd;
      transcript.push({ seat, id: result.id, content: result.content });
      onEvent({ type: "response", seat, id: result.id, turn: turns, usd: result.usd });
      if (result.stopReason === "max_tokens") {
        reason = "output-truncated";
        break;
      }
      histories[seat].push({ role: "assistant", content: result.content });
      const calls = result.content.filter((b) => b.type === "tool_use");
      const speech = result.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const publication = structured && calls.find((call) => call.name === "share_observations");
      if (publication) {
        let snapshot;
        try {
          // As with other tool calls, accompanying model text remains private.
          // Only the explicit speech field and validated records cross the boundary.
          if (seat !== "user" || calls.length !== 1)
            throw new ObservationError("publication-must-be-user-only-single-call");
          snapshot = observations.publish(publication.input);
          const issue = customerGroundingIssue(context.userScenario, publication.input.speech);
          if (issue) throw new ObservationError(issue);
        } catch (error) {
          if (!(error instanceof ObservationError)) throw error;
          const event = {
            type: "observation-failure",
            responseId: result.id,
            issue: error.message,
            turn: turns,
          };
          transcript.push(event);
          onEvent(event);
          reason = "simulator-observation-failure";
          turns++;
          break;
        }
        const event = {
          type: "public-observations",
          responseId: result.id,
          turn: turns,
          speech: publication.input.speech,
          snapshot,
        };
        transcript.push(event);
        onEvent(event);
        publicConversation.push({
          seat: "user",
          text: publication.input.speech,
          observations: snapshot,
        });
        reminderHost?.customerObservations(snapshot);
        histories.user.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: publication.id,
              content: `Published ${snapshot.reportId}.`,
            },
          ],
        });
        histories.actor.push({
          role: "user",
          content: publicObservationMessage(publication.input.speech, snapshot),
        });
        seat = "actor";
        continue;
      }
      if (
        seat === "user" &&
        speech &&
        (!calls.length || calls.some((call) => call.name === "end_conversation"))
      ) {
        const issue = customerGroundingIssue(context.userScenario, speech);
        if (issue) {
          const event = { type: "grounding", responseId: result.id, issue, turn: turns };
          transcript.push(event);
          onEvent(event);
          reason = "simulator-grounding-failure";
          turns++; // The rejected model response is still a charged, completed call.
          break;
        }
      }
      // As in native half-duplex tool interaction, text accompanying a tool call
      // stays private until that participant yields a speech-only response.
      if (calls.length) {
        const responses = [];
        for (const call of calls) {
          if (done) break;
          if (toolCalls >= 1000) {
            reason = "tool-limit";
            done = true;
            break;
          }
          if (seat === "user" && call.name === "end_conversation") {
            done = true;
            reason = "user-ended";
            responses.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: "Conversation ended.",
            });
            if (speech) publicConversation.push({ seat, text: speech });
            continue;
          }
          const response = await bridge.request({
            method: "call",
            role: seat === "actor" ? "assistant" : "user",
            name: call.name,
            arguments: call.input,
          });
          toolCalls++;
          const event = { type: "tool", seat, name: call.name, arguments: call.input, ...response };
          transcript.push(event);
          onEvent(event);
          const references = observations?.observeNative(event);
          if (seat === "actor") reminderHost?.actorTool(event, `actor-tool-${turns}-${toolCalls}`);
          if (seat === "actor" && call.name === "transfer_to_human_agents" && !response.error) {
            done = true;
            reason = "human-transfer";
          }
          responses.push({
            type: "tool_result",
            tool_use_id: call.id,
            content:
              response.content +
              (references
                ? `\n\nShareable diagnostic references (private until explicitly shared):\n${JSON.stringify(references)}`
                : ""),
            is_error: response.error,
          });
        }
        histories[seat].push({ role: "user", content: responses });
      } else if (speech) {
        let delivered = speech;
        if (seat === "user" && structured) {
          let snapshot;
          try {
            snapshot = observations.publish({ speech, observations: [] });
          } catch (error) {
            if (!(error instanceof ObservationError)) throw error;
            const event = {
              type: "observation-failure",
              responseId: result.id,
              issue: error.message,
              turn: turns,
            };
            transcript.push(event);
            onEvent(event);
            reason = "simulator-observation-failure";
            turns++;
            break;
          }
          const event = {
            type: "public-observations",
            responseId: result.id,
            turn: turns,
            speech,
            snapshot,
          };
          transcript.push(event);
          onEvent(event);
          publicConversation.push({ seat, text: speech, observations: snapshot });
          reminderHost?.customerObservations(snapshot);
          delivered = publicObservationMessage(speech, snapshot);
        } else {
          publicConversation.push({ seat, text: speech });
          if (seat === "user") reminderHost?.customerSpeech(speech, `customer-speech-${turns}`);
          else reminderHost?.actorSpeech(speech);
        }
        seat = seat === "actor" ? "user" : "actor";
        histories[seat].push({ role: "user", content: delivered });
      } else {
        reason = "empty-response";
        break;
      }
    }
    const verdict = await bridge.request({ method: "judge" });
    return {
      verdict,
      reason,
      transcript,
      publicConversation,
      calls: turns,
      cost: { providerUsd: usd, toolCalls, wallMs: performance.now() - started },
    };
  } finally {
    bridge.close();
  }
}
