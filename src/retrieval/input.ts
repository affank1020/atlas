import { z } from "zod";
export const fabricSearchSchema = z.object({ query: z.string().trim().min(1).max(4000), projectIds: z.array(z.string().uuid()).optional(), limit: z.number().int().min(1).max(100).optional(), mode: z.enum(["lexical", "semantic", "hybrid"]).optional() });
export const fabricContextSchema = z.object({ query: z.string().trim().min(1).max(4000), projectIds: z.array(z.string().uuid()).optional(), maxRecords: z.number().int().min(1).max(50).optional() });

