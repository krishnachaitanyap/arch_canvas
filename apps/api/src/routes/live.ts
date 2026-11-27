import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { applyPatch, type DiagramModel, DiagramModelSchema, type ModelPatch, personColor } from "@archcanvas/shared";
import { atLeast, HttpError, requireDiagram } from "../access.js";
import { withTenant } from "../db.js";
import { parse } from "./workspaces.js";

/**
 * Live collaboration on a diagram, with no extra services: each editor keeps a streaming
 * connection (Server-Sent Events over fetch) and posts its changes as patches of whole items
 * (see packages/shared/src/live.ts). The room keeps the merged model in memory and sends every
 * patch and cursor to everyone else. Saving stays with the editors (autosave and versions).
 *
 * One API replica per diagram: with several replicas, route a diagram's requests to the same
 * one (sticky sessions on the diagram id) or relay room events through Redis.
 */

interface Client {
  id: string;
  userId: string;
  name: string;
  color: string;
  role: string;
  reply: FastifyReply;
  cursor: { x: number; y: number } | null;
  selection: string[];
}
interface Room {
  model: DiagramModel;
  seq: number;
  clients: Map<string, Client>;
}
const rooms = new Map<string, Room>();

const peerOf = (c: Client) => ({ id: c.id, userId: c.userId, name: c.name, color: c.color, cursor: c.cursor, selection: c.selection, canEdit: atLeast(c.role as never, "editor") });

function send(c: Client, event: unknown) {
  if (!c.reply.raw.writableEnded) c.reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}
function broadcast(room: Room, event: unknown, except?: string) {
  for (const c of room.clients.values()) if (c.id !== except) send(c, event);
}

const clientId = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/);
const message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("patch"), client: clientId, patch: z.record(z.unknown()) }),
  z.object({
    type: z.literal("presence"),
    client: clientId,
    cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
    selection: z.array(z.string().max(200)).max(200).default([]),
  }),
]);

export async function liveRoutes(app: FastifyInstance): Promise<void> {
  /** Join a diagram's room: the stream starts with the current model and who's here. */
  app.get("/api/diagrams/:id/live", async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { client } = parse(z.object({ client: clientId }), req.query);
    const p = req.principal;
    const { diagram, role } = await withTenant(p.tenantId, (c) => requireDiagram(c, id, p, "viewer"));
    if (diagram.kind !== "cloud") throw new HttpError(400, "live editing is for architecture diagrams");

    let room = rooms.get(id);
    if (!room) {
      const model = DiagramModelSchema.safeParse(diagram.model);
      room = { model: model.success ? model.data : { schemaVersion: 1, nodes: [], edges: [], layout: {} }, seq: 0, clients: new Map() };
      rooms.set(id, room);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const me: Client = { id: client, userId: p.userId, name: p.email ?? p.userId, color: personColor(p.userId), role, reply, cursor: null, selection: [] };
    // Same tab reconnecting: replace the old connection.
    room.clients.get(client)?.reply.raw.end();
    room.clients.set(client, me);
    send(me, { type: "welcome", seq: room.seq, model: room.model, you: peerOf(me), peers: [...room.clients.values()].filter((c) => c.id !== client).map(peerOf) });
    broadcast(room, { type: "join", peer: peerOf(me) }, client);

    const ping = setInterval(() => !reply.raw.writableEnded && reply.raw.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      const r = rooms.get(id);
      if (!r || r.clients.get(client) !== me) return;
      r.clients.delete(client);
      broadcast(r, { type: "leave", id: client });
      if (!r.clients.size) rooms.delete(id);
    });
  });

  /** A change or a cursor move from someone in the room. */
  app.post("/api/diagrams/:id/live", async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const msg = parse(message, req.body);
    const room = rooms.get(id);
    const me = room?.clients.get(msg.client);
    // Only the person who opened this connection can speak for it.
    if (!room || !me || me.userId !== req.principal.userId) throw new HttpError(409, "not connected to this diagram; reload to rejoin");
    if (msg.type === "presence") {
      me.cursor = msg.cursor;
      me.selection = msg.selection;
      broadcast(room, { type: "presence", id: me.id, cursor: me.cursor, selection: me.selection }, me.id);
      return reply.code(204).send();
    }
    if (!atLeast(me.role as never, "editor")) throw new HttpError(403, "viewers can't change diagrams");
    const patch = msg.patch as ModelPatch;
    const next = applyPatch(room.model, patch);
    // Keep the room's model valid; a malformed patch is refused rather than shared.
    if (!DiagramModelSchema.safeParse(next).success) throw new HttpError(422, "that change doesn't make a valid diagram");
    room.model = next;
    room.seq++;
    broadcast(room, { type: "patch", seq: room.seq, from: me.id, patch }, me.id);
    return { seq: room.seq };
  });
}
