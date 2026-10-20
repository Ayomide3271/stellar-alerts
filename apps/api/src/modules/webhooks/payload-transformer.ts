export interface PayloadTransformationRule {
  template?: string | Record<string, any>;
  fieldMappings?: Record<string, string>;
  sanitizeKeys?: boolean;
}

export class DynamicPayloadTransformer {
  /**
   * Safe property accessor supporting dot-notation and array indices (e.g. "data.user.items[0].id")
   */
  public getNestedValue(obj: any, path: string): any {
    if (!obj || !path) return undefined;
    const cleanPath = path.replace(/\[(\d+)\]/g, '.$1');
    const parts = cleanPath.split('.').filter(Boolean);

    let current = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }
    return current;
  }

  /**
   * Set value safely at nested path in target object
   */
  public setNestedValue(target: any, path: string, value: any): void {
    if (!target || !path) return;
    const cleanPath = path.replace(/\[(\d+)\]/g, '.$1');
    const parts = cleanPath.split('.').filter(Boolean);

    let current = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
        // If next part is a number, create array, else object
        const nextPartIsNum = !isNaN(Number(parts[i + 1]));
        current[part] = nextPartIsNum ? [] : {};
      }
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  }

  /**
   * Evaluates expressions inside {{...}} in a sandboxed manner without eval
   */
  public evaluateExpression(expression: string, context: Record<string, any>): any {
    const expr = expression.trim();

    // Check for math: prefix e.g. {{math: data.amount * 0.01}}
    if (expr.startsWith('math:')) {
      const mathExpr = expr.substring(5).trim();
      return this.evaluateMathExpression(mathExpr, context);
    }

    // Check for concat: prefix e.g. {{concat: user.firstName, " ", user.lastName}}
    if (expr.startsWith('concat:')) {
      const concatExpr = expr.substring(7).trim();
      return this.evaluateConcatExpression(concatExpr, context);
    }

    // Check for jsonpath / dot notation e.g. {{event.type}} or {{data.amount}}
    if (expr.startsWith('jsonpath:') || expr.startsWith('$.')) {
      const path = expr.replace(/^jsonpath:/, '').replace(/^\$\./, '');
      return this.getNestedValue(context, path);
    }

    // Default dot notation lookup
    const directVal = this.getNestedValue(context, expr);
    if (directVal !== undefined) return directVal;

    return expr;
  }

  private evaluateMathExpression(expr: string, context: Record<string, any>): number {
    // Replace variable names with their values
    let safeExpr = expr.replace(/([a-zA-Z_][a-zA-Z0-9_\.]*)/g, (match) => {
      const val = this.getNestedValue(context, match);
      return val !== undefined && !isNaN(Number(val)) ? String(Number(val)) : '0';
    });

    // Sanitize math string: only allow digits, decimals, whitespace, and + - * / % ( )
    if (!/^[0-9\.\s\+\-\*\/\%\(\)]+$/.test(safeExpr)) {
      return 0;
    }

    try {
      // Safe math execution using Function with strict math args
      const result = new Function(`"use strict"; return (${safeExpr});`)();
      return typeof result === 'number' && !isNaN(result) ? result : 0;
    } catch {
      return 0;
    }
  }

  private evaluateConcatExpression(expr: string, context: Record<string, any>): string {
    const parts = expr.split(',').map((p) => p.trim());
    return parts
      .map((part) => {
        if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
          return part.slice(1, -1);
        }
        const val = this.getNestedValue(context, part);
        return val !== undefined ? String(val) : '';
      })
      .join('');
  }

  /**
   * Applies dynamic transformation template to input payload
   */
  public transform(payload: Record<string, any>, rule: PayloadTransformationRule | string): Record<string, any> {
    if (!rule) return payload;

    const normalizedRule: PayloadTransformationRule =
      typeof rule === 'string' ? { template: rule } : rule;

    const result: Record<string, any> = {};

    // Apply explicit field mappings if provided
    if (normalizedRule.fieldMappings) {
      for (const [targetPath, sourceExpr] of Object.entries(normalizedRule.fieldMappings)) {
        const val = sourceExpr.includes('{{')
          ? this.evaluateTemplateString(sourceExpr, payload)
          : this.evaluateExpression(sourceExpr, payload);
        this.setNestedValue(result, targetPath, val);
      }
    }

    // Apply JSON/String template if provided
    if (normalizedRule.template) {
      if (typeof normalizedRule.template === 'string') {
        try {
          const renderedString = this.evaluateTemplateString(normalizedRule.template, payload);
          return JSON.parse(renderedString);
        } catch {
          return { raw: this.evaluateTemplateString(normalizedRule.template, payload) };
        }
      } else if (typeof normalizedRule.template === 'object') {
        return this.transformObjectTemplate(normalizedRule.template, payload);
      }
    }

    return Object.keys(result).length > 0 ? result : payload;
  }

  private evaluateTemplateString(templateStr: string, context: Record<string, any>): string {
    return templateStr.replace(/\{\{\s*(.*?)\s*\}\}/g, (_, expr) => {
      const val = this.evaluateExpression(expr, context);
      if (val === undefined || val === null) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return String(val);
    });
  }

  private transformObjectTemplate(templateObj: Record<string, any>, context: Record<string, any>): Record<string, any> {
    const res: Record<string, any> = {};

    for (const [key, val] of Object.entries(templateObj)) {
      if (typeof val === 'string') {
        if (val.startsWith('{{') && val.endsWith('}}')) {
          const innerExpr = val.slice(2, -2).trim();
          res[key] = this.evaluateExpression(innerExpr, context);
        } else {
          res[key] = this.evaluateTemplateString(val, context);
        }
      } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        res[key] = this.transformObjectTemplate(val, context);
      } else {
        res[key] = val;
      }
    }

    return res;
  }
}

export const dynamicPayloadTransformer = new DynamicPayloadTransformer();
