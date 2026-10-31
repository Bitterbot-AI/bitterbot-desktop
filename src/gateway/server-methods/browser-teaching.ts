import { z } from "zod";
import { bumpSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import {
  discardStaged,
  readStaged,
  resolveStorageRoots,
} from "../../agents/skills/skill-storage.js";
import { getBrowserControl } from "../../browser/takeover.js";
import {
  compileTeachingDraft,
  defaultTeachingOptions,
  teachingParameters,
} from "../../browser/teaching-draft.js";
import { browserTeaching } from "../../browser/teaching-service.js";
import {
  activateTeachingSkill,
  auditTeachingActivation,
  stageTeachingSkill,
} from "../../browser/teaching-skills.js";
import { teachingDetailsSchema, teachingDraftOptionsSchema } from "../../browser/teaching-types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { currentBrowserLiveView } from "./browser-live.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

const idSchema = z.object({ id: z.string().uuid() }).strict();
const draftSchema = idSchema.extend({ options: teachingDraftOptionsSchema.optional() }).strict();
const activateSchema = idSchema
  .extend({ hash: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true) })
  .strict();

/** Private source material and skill installation require the owner's admin connection. */
function ownerHandler(
  work: (args: GatewayRequestHandlerOptions, connId: string) => Promise<unknown>,
): GatewayRequestHandler {
  return async (args) => {
    if (
      !args.client?.connId ||
      (args.client.connect.role !== undefined && args.client.connect.role !== "operator") ||
      !args.client.connect.scopes?.includes("operator.admin")
    ) {
      args.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Teaching requires an operator.admin connection."),
      );
      return;
    }
    try {
      args.respond(true, await work(args, args.client.connId));
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? "Invalid teaching fields. Check the name, goal, outcome and input names."
          : error instanceof Error && !("code" in error)
            ? error.message
            : "The recording could not be read or saved.";
      args.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    }
  };
}

export const browserTeachingHandlers: GatewayRequestHandlers = {
  "browser.teaching.start": ownerHandler(async ({ params }, connId) => {
    const details = teachingDetailsSchema.parse(params);
    const view = currentBrowserLiveView();
    await view?.flushInput();
    const held = getBrowserControl();
    if (
      !view ||
      view.status().state !== "streaming" ||
      held?.controller !== connId ||
      view.status().profile !== held.profile
    ) {
      throw new Error("Take control of the live browser before recording.");
    }
    await browserTeaching.reconcile(held.controller, held.profile);
    return browserTeaching.start(connId, held.profile, details);
  }),
  "browser.teaching.list": ownerHandler(async () => {
    const held = getBrowserControl();
    await browserTeaching.reconcile(held?.controller, held?.profile);
    return { recordings: await browserTeaching.list() };
  }),
  "browser.teaching.get": ownerHandler(async ({ params }) =>
    browserTeaching.get(idSchema.parse(params).id),
  ),
  "browser.teaching.stop": ownerHandler(async ({ params }, connId) => {
    await currentBrowserLiveView()?.flushInput();
    return browserTeaching.stop(connId, idSchema.parse(params).id);
  }),
  "browser.teaching.draft": ownerHandler(async ({ params }) => {
    const p = draftSchema.parse(params);
    const record = await browserTeaching.get(p.id);
    const options = p.options ?? defaultTeachingOptions(record);
    return {
      record,
      options,
      parameters: teachingParameters(record),
      content: compileTeachingDraft(record, options),
    };
  }),
  "browser.teaching.stage": ownerHandler(async ({ params }) => {
    const p = draftSchema.parse(params);
    return browserTeaching.change(p.id, (record) =>
      stageTeachingSkill(
        record,
        p.options ?? defaultTeachingOptions(record),
        resolveStorageRoots(),
      ),
    );
  }),
  "browser.teaching.activate": ownerHandler(async ({ params }) => {
    const p = activateSchema.parse(params);
    const result = await browserTeaching.change(p.id, async (record) => {
      const result = await activateTeachingSkill(record, p.hash, resolveStorageRoots());
      await auditTeachingActivation(record);
      return result;
    });
    bumpSkillsSnapshotVersion({ reason: "manual" });
    return result;
  }),
  "browser.teaching.delete": ownerHandler(async ({ params }) => {
    const { id } = idSchema.parse(params);
    await browserTeaching.remove(id, async (record) => {
      if (record.status === "recording") throw new Error("Stop the recording before deleting it.");
      if (record.status === "staged" && record.skillName) {
        const roots = resolveStorageRoots();
        const staged = await readStaged(roots, record.skillName);
        if (staged?.meta.author === `human_demonstration:${id}`)
          await discardStaged(roots, record.skillName);
      }
    });
    return { ok: true };
  }),
};
