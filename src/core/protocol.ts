/**
 * Strict, versioned text envelope for advisor turns. The reply must be exactly one
 * JSON object (optionally inside a single ```json fence) carrying
 * "protocol": "wai-advisor-turn/1". JSON is never scraped out of prose or source.
 */
import { type AdvisorTurn, AdvisorTurnSchema, checkSchema, firstSchemaError } from "../contracts.ts";

export const PROTOCOL_ID = "wai-advisor-turn/1";

export type ParsedTurn = { ok: true; turn: AdvisorTurn } | { ok: false; reason: string };

export function parseAdvisorTurn(raw: string): ParsedTurn {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = (fence[1] as string).trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return { ok: false, reason: "Reply must be exactly one JSON object with no surrounding prose." };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `Reply is not valid JSON (${(error as Error).message.slice(0, 120)}).` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "Reply must be a JSON object." };
  const { protocol, ...rest } = value as Record<string, unknown>;
  if (protocol !== PROTOCOL_ID) return { ok: false, reason: `Reply must include "protocol": "${PROTOCOL_ID}".` };
  if (!checkSchema<AdvisorTurn>(AdvisorTurnSchema, rest)) {
    const type = (rest as { type?: unknown }).type;
    return { ok: false, reason: `Reply does not match the ${typeof type === "string" ? `"${type}" ` : ""}turn schema: ${firstSchemaError(AdvisorTurnSchema, rest) ?? "invalid"}.` };
  }
  return { ok: true, turn: rest };
}
