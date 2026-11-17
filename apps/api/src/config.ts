import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().default("postgres://archcanvas:archcanvas@localhost:5432/archcanvas"),
  CORS_ORIGIN: z.string().default("*"),

  OIDC_ISSUER: z.string().optional().default(""),
  OIDC_AUDIENCE: z.string().default("archcanvas"),
  TENANT_CLAIM: z.string().default("tenant"),

  LLM_PROVIDER: z.enum(["anthropic", "vertex", "openai_compatible", "none"]).default("anthropic"),
  LLM_MODEL: z.string().default("claude-sonnet-5-5"),
  ANTHROPIC_API_KEY: z.string().optional(),
  VERTEX_PROJECT_ID: z.string().optional(),
  VERTEX_REGION: z.string().default("us-east5"),
  OPENAI_BASE_URL: z.string().default("http://localhost:11434/v1"),
  OPENAI_API_KEY: z.string().default("not-needed"),
});

export const config = schema.parse(process.env);
export type Config = typeof config;
