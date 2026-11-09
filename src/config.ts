import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  FACET_ENV: z.enum(["local", "preview", "production"]).default("local"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4010),
  IMPORTER_MAX_DOCUMENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10_485_760)
    .default(5_242_880),
  IMPORTER_MAX_YAML_ALIASES: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .default(20),
  IMPORTER_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
  IMPORTER_MAX_REFERENCE_DEPTH: z.coerce
    .number()
    .int()
    .positive()
    .max(64)
    .default(16),
  IMPORTER_MAX_REFERENCE_COUNT: z.coerce
    .number()
    .int()
    .positive()
    .max(2_000)
    .default(256),
  IMPORTER_MAX_OPERATION_COUNT: z.coerce
    .number()
    .int()
    .positive()
    .max(2_000)
    .default(500),
  IMPORTER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(10_000),
});

export type ImporterConfig = z.infer<typeof environmentSchema>;

export function readConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ImporterConfig {
  return environmentSchema.parse(environment);
}
