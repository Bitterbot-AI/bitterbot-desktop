/**
 * Express adapter for the Aubaine clearinghouse (PLAN-26 §12.3) — the agnostic
 * HTTP surface any agent (Claude/GPT/LangChain/a bare script) uses to
 * participate without libp2p or a Bitterbot binary. Routes mirror
 * docs/protocol/aubaine-v1 §6 and mount under `/aubaine`.
 *
 * The handlers are thin: parse the signed Envelope from the JSON body, delegate
 * to the transport-agnostic ClearinghouseService, map results to status codes.
 */
import { type Request, type Response, Router } from "express";
import type { ClearinghouseService, SubmitResult } from "./clearinghouse.js";
import type { Envelope } from "./envelope.js";

/** Coerce an Express query value to a string, ignoring array/object forms. */
function queryString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function send(res: Response, result: SubmitResult): void {
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(202).json({ ok: true, matched: result.matched });
}

export function createClearinghouseRouter(service: ClearinghouseService): Router {
  const router = Router();

  router.post("/intent", (req: Request, res: Response) => {
    send(res, service.submitIntent(req.body as Envelope));
  });

  router.post("/offer", (req: Request, res: Response) => {
    send(res, service.submitOffer(req.body as Envelope));
  });

  router.get("/offers", (req: Request, res: Response) => {
    res.json(service.listOffers(queryString(req.query.sku)));
  });

  router.get("/syndicates", (req: Request, res: Response) => {
    res.json(service.listSyndicates(queryString(req.query.sku)));
  });

  router.get("/events", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: ready\ndata: {}\n\n`);
    const unsubscribe = service.subscribe((event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    req.on("close", unsubscribe);
  });

  return router;
}
