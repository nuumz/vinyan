import { describe, test, expect } from "bun:test";
import { computeCyclomaticComplexity } from "../../src/gate/complexity.ts";

describe("computeCyclomaticComplexity", () => {
  test("empty source returns 1", () => {
    expect(computeCyclomaticComplexity("")).toBe(1);
    expect(computeCyclomaticComplexity("   ")).toBe(1);
  });

  test("simple function with no branches = 1", () => {
    const source = `function add(a: number, b: number) { return a + b; }`;
    expect(computeCyclomaticComplexity(source)).toBe(1);
  });

  test("single if statement = 2", () => {
    const source = `
      function check(x: number) {
        if (x > 0) return "positive";
        return "non-positive";
      }
    `;
    expect(computeCyclomaticComplexity(source)).toBe(2);
  });

  test("if-else-if chain = 3", () => {
    const source = `
      function classify(x: number) {
        if (x > 0) return "positive";
        else if (x < 0) return "negative";
        else return "zero";
      }
    `;
    expect(computeCyclomaticComplexity(source)).toBe(3);
  });

  test("ternary expression counts as branch", () => {
    const source = `const result = x > 0 ? "yes" : "no";`;
    expect(computeCyclomaticComplexity(source)).toBe(2);
  });

  test("for loop = 2", () => {
    const source = `
      function sum(arr: number[]) {
        let total = 0;
        for (let i = 0; i < arr.length; i++) { total += arr[i]; }
        return total;
      }
    `;
    expect(computeCyclomaticComplexity(source)).toBe(2);
  });

  test("while loop = 2", () => {
    const source = `
      function waitFor(cond: () => boolean) {
        while (!cond()) { /* spin */ }
      }
    `;
    expect(computeCyclomaticComplexity(source)).toBe(2);
  });

  test("do-while loop = 2", () => {
    const source = `
      function doStuff() {
        let i = 0;
        do { i++; } while (i < 10);
      }
    `;
    expect(computeCyclomaticComplexity(source)).toBe(2);
  });

  test("for-of loop = 2", () => {
    const source = `
      function process(items: string[]) {
        for (const item of items) { console.log(item); }
      }
    `;
    expect(computeCyclomaticComplexity(source)).toBe(2);
  });

  test("switch-case adds per case", () => {
    const source = `
      function handle(action: string) {
        switch (action) {
          case "a": return 1;
          case "b": return 2;
          case "c": return 3;
          default: return 0;
        }
      }
    `;
    // 1 (base) + 3 case clauses (default is DefaultClause, not CaseClause)
    expect(computeCyclomaticComplexity(source)).toBe(4);
  });

  test("logical AND/OR count as branches", () => {
    const source = `
      function guard(a: boolean, b: boolean, c: boolean) {
        if (a && b || c) return true;
        return false;
      }
    `;
    // 1 (base) + 1 (if) + 1 (&&) + 1 (||) = 4
    expect(computeCyclomaticComplexity(source)).toBe(4);
  });

  test("nullish coalescing (??) counts as branch", () => {
    const source = `const x = a ?? b;`;
    expect(computeCyclomaticComplexity(source)).toBe(2);
  });

  test("catch clause counts as branch", () => {
    const source = `
      function safe() {
        try { riskyOp(); }
        catch (e) { handleError(e); }
      }
    `;
    expect(computeCyclomaticComplexity(source)).toBe(2);
  });

  test("complex function with multiple branches", () => {
    const source = `
      function complex(items: any[], flag: boolean) {
        if (!items || items.length === 0) return null;    // +1 if, +1 ||
        for (const item of items) {                        // +1 for-of
          if (flag && item.active) {                       // +1 if, +1 &&
            try {
              process(item);
            } catch (e) {                                  // +1 catch
              console.error(e);
            }
          }
        }
        return flag ? "done" : "skipped";                  // +1 ternary
      }
    `;
    // 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 = 8
    expect(computeCyclomaticComplexity(source)).toBe(8);
  });
});
