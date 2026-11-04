import type { ReferenceObject, SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z, type ZodType } from 'zod';

type Json = Record<string, unknown>;
const COMPONENTS = '#/components/schemas/';
const OPTS = { target: 'openapi-3.0', unrepresentable: 'any', io: 'input' } as const;

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') {
    const out: Json = {};
    const obj = node as Json;
    // `format: date-time` is enough for generated clients; zod's long regex trips some generators.
    const dropPattern = obj.format === 'date-time' || obj.format === 'email' || obj.format === 'uuid';
    for (const [k, v] of Object.entries(obj)) {
      if (dropPattern && k === 'pattern') continue;
      if (k === '$ref' && typeof v === 'string') out[k] = v.replace('#/definitions/', COMPONENTS);
      else if (k !== 'definitions' && k !== '$id' && k !== '$schema') out[k] = rewriteRefs(v);
    }
    // OpenAPI 3.0 nullability for generated clients: a nullable enum must list null, and a nullable
    // $ref wrapper (allOf: [$ref]) needs an explicit type (every referenced schema here is an object).
    // OpenAPI 3.0 has no `type: null`: a null member of anyOf/oneOf becomes `nullable: true` (BI-7).
    for (const k of ['anyOf', 'oneOf'] as const) {
      const members = out[k] as Json[] | undefined;
      const isNull = (m: Json) => m?.type === 'null' || (Array.isArray(m?.enum) && m.enum.length === 1 && m.enum[0] === null);
      if (Array.isArray(members) && members.some(isNull)) {
        const rest = members.filter((m) => !isNull(m));
        if (rest.length === 1 && Object.keys(out).length === 1) return { ...rest[0], nullable: true };
        // OAS 3.0 ignores `nullable` without `type` (QA B24), so null goes on a typed member instead.
        // Members of distinct types cannot overlap: emit oneOf with null on exactly one member.
        // Otherwise keep anyOf (several members may match) with every member nullable.
        const kind = (m: Json) => (m.type === 'integer' ? 'number' : m.type);
        const kinds = rest.map(kind);
        delete out[k];
        if (kinds.every((t) => typeof t === 'string') && new Set(kinds).size === kinds.length) {
          out.oneOf = rest.map((m, i) => (i === rest.length - 1 ? { ...m, nullable: true } : m));
        } else {
          out.anyOf = rest.map((m) => ({ ...m, nullable: true }));
        }
      }
    }
    if (out.nullable === true && Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    if (out.nullable === true && Array.isArray(out.allOf) && out.type === undefined) out.type = 'object';
    return out;
  }
  return node;
}

/** OpenAPI schema for a zod schema; registered schemas (meta id) become $refs to components. */
export function toOpenApi(schema: ZodType): SchemaObject | ReferenceObject {
  const id = z.globalRegistry.get(schema)?.id;
  if (id) return { $ref: COMPONENTS + id };
  return rewriteRefs(z.toJSONSchema(schema, { ...OPTS, metadata: z.globalRegistry })) as SchemaObject;
}

/** Every schema registered with `.meta({ id })`, as OpenAPI components. */
export function zodComponents(): Record<string, SchemaObject> {
  const all = z.toJSONSchema(z.globalRegistry, { ...OPTS, uri: (id) => COMPONENTS + id });
  return rewriteRefs(all.schemas) as Record<string, SchemaObject>;
}
