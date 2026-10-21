import type { QuotaSnapshot } from "../model";
import type { FormatError, SpecResult } from "./errors";
import { parseNumberSpec, type NumberSpec } from "./numberSpec";
import { parseTextSpec, type TextSpec } from "./textSpec";
import { parseTimeSpec, type TimeSpec } from "./timeSpec";
import { isVariableName, VARIABLES, type VariableName } from "./variables";

export interface LiteralToken {
  readonly type: "literal";
  readonly text: string;
}

interface FieldBase {
  readonly type: "field";
  readonly variable: VariableName;
  /** Offset of the opening brace in the format string. */
  readonly position: number;
}

export interface NumberField extends FieldBase {
  readonly kind: "number";
  readonly spec: NumberSpec;
  readonly resolve: (snapshot: QuotaSnapshot) => number | null;
}

export interface TimeField extends FieldBase {
  readonly kind: "time";
  readonly spec: TimeSpec;
  readonly resolve: (snapshot: QuotaSnapshot) => number | null;
}

export interface TextField extends FieldBase {
  readonly kind: "text";
  readonly spec: TextSpec;
  readonly resolve: (snapshot: QuotaSnapshot) => string | null;
}

export type FieldToken = NumberField | TimeField | TextField;

export type Token = LiteralToken | FieldToken;

export type ParseResult =
  | { readonly ok: true; readonly tokens: readonly Token[] }
  | { readonly ok: false; readonly errors: readonly FormatError[] };

type FieldParse =
  | { readonly ok: true; readonly field: FieldToken }
  | { readonly ok: false; readonly error: FormatError };

/**
 * Parses a Python-style format string: `{variable}`, `{variable:spec}`, `{{`
 * and `}}` for literal braces. Everything else, including `$(codicon)`, is
 * literal text. Problems are returned, never thrown.
 */
export function parseFormat(format: string): ParseResult {
  const tokens: Token[] = [];
  const errors: FormatError[] = [];
  let literal = "";

  const flushLiteral = (): void => {
    if (literal !== "") {
      tokens.push({ type: "literal", text: literal });
      literal = "";
    }
  };

  let i = 0;
  while (i < format.length) {
    const char = format.charAt(i);
    const next = format.charAt(i + 1);
    if ((char === "{" || char === "}") && next === char) {
      literal += char;
      i += 2;
    } else if (char === "}") {
      errors.push({ position: i, message: 'Single "}" is not allowed; use "}}" for a literal brace' });
      i += 1;
    } else if (char === "{") {
      const end = findFieldEnd(format, i + 1);
      if (end.kind === "closed") {
        const parsed = parseField(format, i, end.index);
        if (parsed.ok) {
          flushLiteral();
          tokens.push(parsed.field);
        } else {
          errors.push(parsed.error);
        }
        i = end.index + 1;
      } else {
        errors.push(end.error(i));
        i = end.index;
      }
    } else {
      literal += char;
      i += 1;
    }
  }
  flushLiteral();

  return errors.length === 0 ? { ok: true, tokens } : { ok: false, errors };
}

type FieldEnd =
  | { readonly kind: "closed"; readonly index: number }
  | {
      readonly kind: "broken";
      /** Where scanning resumes. */
      readonly index: number;
      readonly error: (openPosition: number) => FormatError;
    };

/** Finds the `}` that closes a field whose content starts at `from`. */
function findFieldEnd(format: string, from: number): FieldEnd {
  for (let j = from; j < format.length; j += 1) {
    const char = format.charAt(j);
    if (char === "}") {
      return { kind: "closed", index: j };
    }
    if (char === "{") {
      return {
        kind: "broken",
        index: j,
        error: () => ({ position: j, message: 'Unexpected "{" inside a field; nested fields are not supported' }),
      };
    }
  }
  return {
    kind: "broken",
    index: format.length,
    error: (openPosition) => ({ position: openPosition, message: 'Unclosed "{"; use "{{" for a literal brace' }),
  };
}

/** Parses the field between the braces at `open` and `close`. */
function parseField(format: string, open: number, close: number): FieldParse {
  const content = format.slice(open + 1, close);
  const colon = content.indexOf(":");
  const name = colon === -1 ? content : content.slice(0, colon);
  const specText = colon === -1 ? "" : content.slice(colon + 1);
  const specPosition = open + 1 + name.length + 1;

  if (name === "") {
    return fail(open + 1, "Missing variable name");
  }
  if (!isVariableName(name)) {
    return fail(open + 1, `Unknown variable "${name}"`);
  }
  const base = { type: "field", variable: name, position: open } as const;
  const definition = VARIABLES[name];
  switch (definition.kind) {
    case "number": {
      const spec = parseNumberSpec(specText);
      return spec.ok
        ? succeed({ ...base, kind: "number", spec: spec.spec, resolve: definition.resolve })
        : specFailure(spec, specPosition, name);
    }
    case "time": {
      const spec = parseTimeSpec(specText);
      return spec.ok
        ? succeed({ ...base, kind: "time", spec: spec.spec, resolve: definition.resolve })
        : specFailure(spec, specPosition, name);
    }
    case "text": {
      const spec = parseTextSpec(specText);
      return spec.ok
        ? succeed({ ...base, kind: "text", spec: spec.spec, resolve: definition.resolve })
        : specFailure(spec, specPosition, name);
    }
  }
}

function succeed(field: FieldToken): FieldParse {
  return { ok: true, field };
}

function fail(position: number, message: string): FieldParse {
  return { ok: false, error: { position, message } };
}

function specFailure<T>(
  result: Extract<SpecResult<T>, { ok: false }>,
  position: number,
  variable: VariableName,
): FieldParse {
  return fail(position, `${result.message} (variable "${variable}" is ${VARIABLES[variable].kind})`);
}
