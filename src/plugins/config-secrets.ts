import { isSensitiveConfigPath } from "../config/schema.hints.js";
import { ENV_SECRET_REF_ID_RE } from "../config/types.secrets.js";
import {
  EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN,
  FILE_SECRET_REF_ID_PATTERN,
  SECRET_PROVIDER_ALIAS_PATTERN,
} from "../secrets/ref-contract.js";
import type { PluginConfigUiHint } from "./types.js";

type JsonSchemaNode = Record<string, unknown>;

type JsonSchemaObject = JsonSchemaNode & {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  additionalProperties?: JsonSchemaObject | boolean;
  items?: JsonSchemaObject | JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  enum?: unknown[];
  const?: unknown;
};

type PluginSecretPathMetadata = {
  pathPattern: string;
};

const EXTRA_SECRET_LEAF_NAMES = new Set(["auth", "authorization"]);

const SECRET_REF_JSON_SCHEMA: JsonSchemaObject = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { const: "env" },
        provider: {
          type: "string",
          pattern: SECRET_PROVIDER_ALIAS_PATTERN.source,
        },
        id: {
          type: "string",
          pattern: ENV_SECRET_REF_ID_RE.source,
        },
      },
      required: ["source", "provider", "id"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { const: "file" },
        provider: {
          type: "string",
          pattern: SECRET_PROVIDER_ALIAS_PATTERN.source,
        },
        id: {
          type: "string",
          pattern: FILE_SECRET_REF_ID_PATTERN.source,
        },
      },
      required: ["source", "provider", "id"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { const: "exec" },
        provider: {
          type: "string",
          pattern: SECRET_PROVIDER_ALIAS_PATTERN.source,
        },
        id: {
          type: "string",
          pattern: EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN,
        },
      },
      required: ["source", "provider", "id"],
    },
  ],
};

function cloneSchema<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function asSchemaObject(value: unknown): JsonSchemaObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchemaObject;
}

function appendPath(basePath: string, segment: string): string {
  if (!basePath) {
    return segment;
  }
  return `${basePath}.${segment}`;
}

function splitPatternSegments(path: string): string[] {
  const normalized = path.trim().replace(/^\./, "");
  if (!normalized) {
    return [];
  }
  const out: string[] = [];
  for (const segment of normalized.split(".").filter(Boolean)) {
    if (segment === "*" || segment === "[]") {
      out.push(segment);
      continue;
    }
    if (segment.endsWith("[]")) {
      const field = segment.slice(0, -2).trim();
      if (field) {
        out.push(field);
      }
      out.push("[]");
      continue;
    }
    out.push(segment);
  }
  return out;
}

function matchUiHintByPath(
  uiHints: Record<string, PluginConfigUiHint>,
  path: string,
): PluginConfigUiHint | null {
  const targetSegments = splitPatternSegments(path);
  let bestMatch: { hint: PluginConfigUiHint; wildcardCount: number } | null = null;

  for (const [hintPath, hint] of Object.entries(uiHints)) {
    const hintSegments = splitPatternSegments(hintPath);
    if (hintSegments.length !== targetSegments.length) {
      continue;
    }

    let wildcardCount = 0;
    let matches = true;
    for (let index = 0; index < hintSegments.length; index += 1) {
      const hintSegment = hintSegments[index];
      const targetSegment = targetSegments[index];
      if (hintSegment === targetSegment) {
        continue;
      }
      if (hintSegment === "*") {
        wildcardCount += 1;
        continue;
      }
      matches = false;
      break;
    }

    if (!matches) {
      continue;
    }
    if (!bestMatch || wildcardCount < bestMatch.wildcardCount) {
      bestMatch = { hint, wildcardCount };
    }
  }

  return bestMatch?.hint ?? null;
}

function resolveSensitiveOverride(
  uiHints: Record<string, PluginConfigUiHint> | undefined,
  path: string,
): boolean | undefined {
  if (!uiHints) {
    return undefined;
  }
  const matched = matchUiHintByPath(uiHints, path);
  return matched?.sensitive;
}

function schemaSupportsStrings(schema: JsonSchemaObject): boolean {
  const type = schema.type;
  if (type === "string") {
    return true;
  }
  if (Array.isArray(type) && type.includes("string")) {
    return true;
  }
  if (typeof schema.const === "string") {
    return true;
  }
  if (Array.isArray(schema.enum) && schema.enum.some((value) => typeof value === "string")) {
    return true;
  }
  return [schema.anyOf, schema.oneOf, schema.allOf].some((branch) =>
    Array.isArray(branch)
      ? branch.some((entry) => {
          const branchSchema = asSchemaObject(entry);
          return branchSchema ? schemaSupportsStrings(branchSchema) : false;
        })
      : false,
  );
}

function leafSegmentForPath(path: string): string {
  const segments = splitPatternSegments(path);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === "*" || segment === "[]") {
      continue;
    }
    return segment;
  }
  return "";
}

function shouldTreatPathAsSecret(params: {
  path: string;
  schema: JsonSchemaObject;
  uiHints?: Record<string, PluginConfigUiHint>;
}): boolean {
  const override = resolveSensitiveOverride(params.uiHints, params.path);
  if (override !== undefined) {
    return override;
  }
  if (isSensitiveConfigPath(params.path)) {
    return true;
  }
  const leaf = leafSegmentForPath(params.path).toLowerCase();
  return EXTRA_SECRET_LEAF_NAMES.has(leaf) && schemaSupportsStrings(params.schema);
}

function collectPluginSecretPaths(params: {
  schema: JsonSchemaObject;
  path: string;
  uiHints?: Record<string, PluginConfigUiHint>;
  out: PluginSecretPathMetadata[];
  seen: Set<string>;
}): void {
  if (params.path && shouldTreatPathAsSecret(params)) {
    const key = params.path;
    if (!params.seen.has(key)) {
      params.seen.add(key);
      params.out.push({ pathPattern: params.path });
    }
  }

  for (const [propertyKey, propertySchema] of Object.entries(params.schema.properties ?? {})) {
    const childSchema = asSchemaObject(propertySchema);
    if (!childSchema) {
      continue;
    }
    collectPluginSecretPaths({
      schema: childSchema,
      path: appendPath(params.path, propertyKey),
      uiHints: params.uiHints,
      out: params.out,
      seen: params.seen,
    });
  }

  const additionalProperties = asSchemaObject(params.schema.additionalProperties);
  if (additionalProperties) {
    collectPluginSecretPaths({
      schema: additionalProperties,
      path: appendPath(params.path, "*"),
      uiHints: params.uiHints,
      out: params.out,
      seen: params.seen,
    });
  }

  const itemSchemas = Array.isArray(params.schema.items)
    ? params.schema.items
    : params.schema.items
      ? [params.schema.items]
      : [];
  for (const itemSchema of itemSchemas) {
    const childSchema = asSchemaObject(itemSchema);
    if (!childSchema) {
      continue;
    }
    collectPluginSecretPaths({
      schema: childSchema,
      path: appendPath(params.path, "[]"),
      uiHints: params.uiHints,
      out: params.out,
      seen: params.seen,
    });
  }

  for (const branch of [params.schema.anyOf, params.schema.oneOf, params.schema.allOf]) {
    if (!Array.isArray(branch)) {
      continue;
    }
    for (const branchSchemaRaw of branch) {
      const branchSchema = asSchemaObject(branchSchemaRaw);
      if (!branchSchema) {
        continue;
      }
      collectPluginSecretPaths({
        schema: branchSchema,
        path: params.path,
        uiHints: params.uiHints,
        out: params.out,
        seen: params.seen,
      });
    }
  }
}

function transformPluginSchema(params: {
  schema: JsonSchemaObject;
  path: string;
  uiHints?: Record<string, PluginConfigUiHint>;
}): JsonSchemaObject {
  const next = cloneSchema(params.schema);

  if (next.properties) {
    for (const [propertyKey, propertySchema] of Object.entries(next.properties)) {
      const childSchema = asSchemaObject(propertySchema);
      if (!childSchema) {
        continue;
      }
      next.properties[propertyKey] = transformPluginSchema({
        schema: childSchema,
        path: appendPath(params.path, propertyKey),
        uiHints: params.uiHints,
      });
    }
  }

  const additionalProperties = asSchemaObject(next.additionalProperties);
  if (additionalProperties) {
    next.additionalProperties = transformPluginSchema({
      schema: additionalProperties,
      path: appendPath(params.path, "*"),
      uiHints: params.uiHints,
    });
  }

  if (Array.isArray(next.items)) {
    next.items = next.items.map((itemSchema) => {
      const childSchema = asSchemaObject(itemSchema);
      if (!childSchema) {
        return itemSchema;
      }
      return transformPluginSchema({
        schema: childSchema,
        path: appendPath(params.path, "[]"),
        uiHints: params.uiHints,
      });
    });
  } else {
    const childSchema = asSchemaObject(next.items);
    if (childSchema) {
      next.items = transformPluginSchema({
        schema: childSchema,
        path: appendPath(params.path, "[]"),
        uiHints: params.uiHints,
      });
    }
  }

  for (const branchKey of ["anyOf", "oneOf", "allOf"] as const) {
    const branch = next[branchKey];
    if (!Array.isArray(branch)) {
      continue;
    }
    next[branchKey] = branch.map((entry) => {
      const branchSchema = asSchemaObject(entry);
      if (!branchSchema) {
        return entry;
      }
      return transformPluginSchema({
        schema: branchSchema,
        path: params.path,
        uiHints: params.uiHints,
      });
    });
  }

  if (
    params.path &&
    schemaSupportsStrings(next) &&
    shouldTreatPathAsSecret({
      path: params.path,
      schema: next,
      uiHints: params.uiHints,
    })
  ) {
    return {
      anyOf: [next, cloneSchema(SECRET_REF_JSON_SCHEMA)],
    };
  }

  return next;
}

export function listPluginConfigSecretPaths(params: {
  schema?: Record<string, unknown>;
  uiHints?: Record<string, PluginConfigUiHint>;
}): string[] {
  const schema = asSchemaObject(params.schema);
  if (!schema) {
    return [];
  }
  const out: PluginSecretPathMetadata[] = [];
  collectPluginSecretPaths({
    schema,
    path: "",
    uiHints: params.uiHints,
    out,
    seen: new Set<string>(),
  });
  return out.map((entry) => entry.pathPattern).toSorted((left, right) => left.localeCompare(right));
}

export function augmentPluginConfigUiHints(params: {
  schema?: Record<string, unknown>;
  uiHints?: Record<string, PluginConfigUiHint>;
}): Record<string, PluginConfigUiHint> | undefined {
  const secretPaths = listPluginConfigSecretPaths(params);
  if (secretPaths.length === 0) {
    return params.uiHints;
  }

  const next = { ...params.uiHints };
  let changed = false;
  for (const path of secretPaths) {
    const current = next[path];
    if (current?.sensitive === true) {
      continue;
    }
    if (current?.sensitive === false) {
      continue;
    }
    next[path] = {
      ...current,
      sensitive: true,
    };
    changed = true;
  }

  if (!changed && params.uiHints) {
    return params.uiHints;
  }
  return next;
}

export function augmentPluginConfigSchema(params: {
  schema?: Record<string, unknown>;
  uiHints?: Record<string, PluginConfigUiHint>;
}): Record<string, unknown> | undefined {
  const schema = asSchemaObject(params.schema);
  if (!schema) {
    return params.schema;
  }
  return transformPluginSchema({
    schema,
    path: "",
    uiHints: params.uiHints,
  });
}
