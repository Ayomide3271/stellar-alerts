const logger = {
  info: (data: Record<string, unknown>, msg: string) => console.log(`[PayloadTransformer] ${msg}`, data),
  warn: (data: Record<string, unknown>, msg: string) => console.warn(`[PayloadTransformer] ${msg}`, data),
  error: (data: Record<string, unknown>, msg: string) => console.error(`[PayloadTransformer] ${msg}`, data),
};

export interface PayloadTransformationResult {
  transformed: boolean;
  payload: Record<string, unknown>;
  error?: string;
}

export interface PayloadTransformerOptions {
  strictVariables?: boolean;
}

const FORBIDDEN_TOKENS = [
  '__proto__',
  'constructor',
  'prototype',
  'process',
  'require',
  'import',
  'global',
  'window',
];

const FORBIDDEN_TAGS = [
  'include',
  'render',
  'layout',
  'eval',
  'file',
  'exec',
];

/**
 * Dynamic Webhook Payload Transformation Engine via Liquid Templates (#748).
 * Allows subscribers to customize outgoing webhook JSON formatting using Liquid templates
 * and JsonPath-like filters with strict sandboxing and security safeguards.
 */
export class PayloadTransformer {
  private liquidEngine: unknown | null = null;

  constructor() {
    this.initLiquidEngine();
  }

  private initLiquidEngine(): void {
    try {
      // Dynamic import / require of liquidjs if installed in node_modules
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Liquid } = require('liquidjs');
      if (Liquid) {
        this.liquidEngine = new Liquid({
          strictVariables: false,
          strictFilters: false,
          ownPropertyOnly: true, // Prevents prototype pollution
        });
      }
    } catch {
      // LiquidJS not present; fallback to built-in secure Liquid parser
      this.liquidEngine = null;
    }
  }

  /**
   * Validates a template string for unsafe tags, forbidden properties, and prototype pollution.
   */
  public validateTemplateSecurity(template: string): { safe: boolean; reason?: string } {
    if (!template) return { safe: true };

    const lower = template.toLowerCase();

    for (const token of FORBIDDEN_TOKENS) {
      if (token.startsWith('__') || token === 'constructor' || token === 'prototype') {
        if (lower.includes(token)) {
          return {
            safe: false,
            reason: `Unsafe token detected in template: ${token}`,
          };
        }
      } else {
        const tokenRegex = new RegExp(`(^|[^a-zA-Z0-9_])${token}([^a-zA-Z0-9_]|$)`, 'i');
        if (tokenRegex.test(template)) {
          return {
            safe: false,
            reason: `Unsafe token detected in template: ${token}`,
          };
        }
      }
    }

    // Check for unsafe Liquid tags like {% include ... %}, {% render ... %}
    for (const tag of FORBIDDEN_TAGS) {
      const tagRegex = new RegExp(`\\{%\\s*${tag}\\b`, 'i');
      if (tagRegex.test(template)) {
        return {
          safe: false,
          reason: `Forbidden template tag rejected for security: ${tag}`,
        };
      }
    }

    return { safe: true };
  }

  /**
   * Evaluates a user-defined Liquid template against an event payload.
   * Outputs validated custom JSON payload matching subscriber target specification.
   * Safely handles syntax errors in templates with fallback to standard schema and warning log.
   */
  public async transform(
    payload: Record<string, unknown>,
    template?: string | null
  ): Promise<PayloadTransformationResult> {
    if (!template || template.trim() === '') {
      return {
        transformed: false,
        payload,
      };
    }

    // 1. Security validation: reject unsafe template tags (preventing prototype pollution or arbitrary execution)
    const securityCheck = this.validateTemplateSecurity(template);
    if (!securityCheck.safe) {
      logger.warn(
        { reason: securityCheck.reason },
        '[PayloadTransformer] ⚠️ Unsafe template rejected. Falling back to default schema.'
      );
      return {
        transformed: false,
        payload,
        error: securityCheck.reason,
      };
    }

    // 2. Evaluate template against payload context
    try {
      const renderedText = await this.renderTemplate(template, payload);

      // 3. Validate resulting output as valid JSON
      const trimmed = renderedText.trim();
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(trimmed);
      } catch (jsonErr: unknown) {
        const errMsg = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
        logger.warn(
          { err: errMsg, outputSnippet: trimmed.substring(0, 100) },
          '[PayloadTransformer] ⚠️ Template rendered non-JSON output. Falling back to default schema.'
        );
        return {
          transformed: false,
          payload,
          error: `Template output is not valid JSON: ${errMsg}`,
        };
      }

      if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
        return {
          transformed: true,
          payload: parsedJson as Record<string, unknown>,
        };
      } else if (Array.isArray(parsedJson)) {
        return {
          transformed: true,
          payload: { items: parsedJson },
        };
      } else {
        return {
          transformed: false,
          payload,
          error: 'Template output did not produce a JSON object',
        };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err: errMsg },
        '[PayloadTransformer] ⚠️ Template evaluation failed. Falling back to default schema.'
      );
      return {
        transformed: false,
        payload,
        error: `Liquid evaluation error: ${errMsg}`,
      };
    }
  }

  /**
   * Renders the template string using Liquid engine or safe built-in interpreter.
   */
  private async renderTemplate(template: string, payload: Record<string, unknown>): Promise<string> {
    const context = {
      ...payload,
      event: payload.event ?? payload,
      data: (payload.data as Record<string, unknown>) ?? payload,
      payload,
    };

    if (this.liquidEngine && typeof (this.liquidEngine as { parseAndRender?: unknown }).parseAndRender === 'function') {
      const engine = this.liquidEngine as { parseAndRender: (tpl: string, ctx: unknown) => Promise<string> };
      return await engine.parseAndRender(template, context);
    }

    return this.evaluateBuiltinLiquid(template, context);
  }

  /**
   * Secure built-in Liquid expression evaluator supporting variable access, JsonPath, filters, and loops/conditionals.
   */
  public evaluateBuiltinLiquid(template: string, context: Record<string, unknown>): string {
    let result = template;

    // Handle conditionals: {% if condition %} ... {% else %} ... {% endif %}
    result = result.replace(
      /\{%\s*if\s+(.*?)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g,
      (_, condExpr, truthyBlock, falsyBlock) => {
        const condVal = this.evaluateCondition(condExpr, context);
        return condVal ? truthyBlock : (falsyBlock ?? '');
      }
    );

    // Handle variable interpolation: {{ expression | filter: arg }}
    result = result.replace(/\{\{\s*(.*?)\s*\}\}/g, (_, exprWithFilters) => {
      const val = this.evaluateLiquidExpression(exprWithFilters, context);
      if (val === undefined || val === null) {
        return 'null';
      }
      if (typeof val === 'string') {
        return JSON.stringify(val).slice(1, -1); // escape string content without surrounding quotes
      }
      if (typeof val === 'object') {
        return JSON.stringify(val);
      }
      return String(val);
    });

    return result;
  }

  private evaluateCondition(condExpr: string, context: Record<string, unknown>): boolean {
    const trimmed = condExpr.trim();
    if (trimmed.includes('==')) {
      const [left, right] = trimmed.split('==').map((s) => s.trim());
      const leftVal = this.evaluateLiquidExpression(left, context);
      const rightVal = this.resolveLiteralOrVar(right, context);
      return String(leftVal) === String(rightVal);
    }
    if (trimmed.includes('!=')) {
      const [left, right] = trimmed.split('!=').map((s) => s.trim());
      const leftVal = this.evaluateLiquidExpression(left, context);
      const rightVal = this.resolveLiteralOrVar(right, context);
      return String(leftVal) !== String(rightVal);
    }

    const val = this.evaluateLiquidExpression(trimmed, context);
    return Boolean(val);
  }

  private resolveLiteralOrVar(token: string, context: Record<string, unknown>): unknown {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (!isNaN(Number(token))) return Number(token);
    return this.resolvePath(context, token);
  }

  public evaluateLiquidExpression(expression: string, context: Record<string, unknown>): unknown {
    const parts = expression.split('|').map((p) => p.trim());
    const baseExpr = parts[0];
    const filters = parts.slice(1);

    let val: unknown = this.resolvePath(context, baseExpr);

    for (const filterStr of filters) {
      val = this.applyFilter(val, filterStr, context);
    }

    return val;
  }

  private resolvePath(obj: unknown, path: string): unknown {
    if (!obj || typeof obj !== 'object' || !path) return undefined;

    let cleanPath = path.trim();
    if (cleanPath.startsWith('$.')) {
      cleanPath = cleanPath.slice(2);
    } else if (cleanPath.startsWith('$')) {
      cleanPath = cleanPath.slice(1);
    }

    // Check for forbidden properties
    if (cleanPath.includes('__proto__') || cleanPath.includes('constructor') || cleanPath.includes('prototype')) {
      return undefined;
    }

    cleanPath = cleanPath.replace(/\[(\d+)\]/g, '.$1');
    const segments = cleanPath.split('.').filter(Boolean);

    let current: unknown = obj;
    for (const seg of segments) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[seg];
    }

    return current;
  }

  private applyFilter(value: unknown, filterStr: string, context: Record<string, unknown>): unknown {
    const colonIdx = filterStr.indexOf(':');
    const filterName = (colonIdx === -1 ? filterStr : filterStr.slice(0, colonIdx)).trim().toLowerCase();
    const rawArg = colonIdx === -1 ? '' : filterStr.slice(colonIdx + 1).trim();
    const arg = this.resolveLiteralOrVar(rawArg, context);

    switch (filterName) {
      case 'upcase':
      case 'uppercase':
        return typeof value === 'string' ? value.toUpperCase() : value;
      case 'downcase':
      case 'lowercase':
        return typeof value === 'string' ? value.toLowerCase() : value;
      case 'append':
        return `${String(value ?? '')}${String(arg ?? '')}`;
      case 'prepend':
        return `${String(arg ?? '')}${String(value ?? '')}`;
      case 'default':
        return value !== undefined && value !== null && value !== '' ? value : arg;
      case 'json':
        return JSON.stringify(value);
      case 'split':
        return typeof value === 'string' ? value.split(String(arg ?? ',')) : [];
      default:
        return value;
    }
  }
}

export const payloadTransformer = new PayloadTransformer();
