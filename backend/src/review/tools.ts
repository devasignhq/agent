// Tool schemas the model is forced to call for its structured stages. Pure data.
import type { StructuredTool } from "../llm.js";

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;
const int = { type: "integer" } as const;

const codeRef = {
  type: ["object", "null"],
  properties: { path: str, startLine: int, language: nullableStr, code: str },
  required: ["path", "startLine", "code"],
} as const;

const patch = {
  type: ["object", "null"],
  properties: { path: str, startLine: int, original: str, suggested: str },
  required: ["path", "startLine", "original", "suggested"],
} as const;

export const reviewVerdictTool: StructuredTool = {
  name: "submit_review_verdict",
  description: "Submit the PR review verdict: one entry per acceptance criterion, line comments, and suggestions.",
  inputSchema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["passed", "changes_requested"] },
      summary: str,
      criteria: {
        type: "array",
        items: {
          type: "object",
          properties: { id: str, met: { type: "boolean" }, evidence: str, evidenceCode: codeRef, suggestedChange: patch },
          required: ["id", "met", "evidence"],
        },
      },
      comments: {
        type: "array",
        items: { type: "object", properties: { path: str, line: int, body: str }, required: ["path", "line", "body"] },
      },
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            criterionId: nullableStr,
            title: str,
            rationale: str,
            path: str,
            line: int,
            severity: { type: "string", enum: ["blocker", "warn", "nit"] },
            suggestedChange: patch,
            fixPrompt: str,
          },
          required: ["title", "rationale", "severity", "fixPrompt"],
        },
      },
    },
    required: ["verdict", "summary", "criteria", "comments", "suggestions"],
  },
};

const testLevel = { type: "string", enum: ["unit", "integration", "component", "e2e"] } as const;
const testRunner = { type: "string", enum: ["vitest", "jest", "pytest", "playwright", "go", "node-test", "bundled"] } as const;

export const planManifestTool: StructuredTool = {
  name: "submit_test_plan",
  description: "Submit the test plan: which test proves each criterion, and which criteria no allowed test can decide.",
  inputSchema: {
    type: "object",
    properties: {
      tests: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: str,
            criterionIds: { type: "array", items: str },
            level: testLevel,
            levelReason: str,
            origin: { type: "string", enum: ["existing", "generated"] },
            runner: testRunner,
            targetFiles: { type: "array", items: str },
            strategy: str,
          },
          required: ["path", "criterionIds", "level", "levelReason", "origin", "runner", "targetFiles"],
        },
      },
      unverifiable: {
        type: "array",
        items: { type: "object", properties: { criterionId: str, reason: str }, required: ["criterionId", "reason"] },
      },
    },
    required: ["tests", "unverifiable"],
  },
};

export const planTestFileTool: StructuredTool = {
  name: "submit_test_file",
  description: "Submit the complete contents of one generated test file.",
  inputSchema: {
    type: "object",
    properties: { path: str, content: str },
    required: ["path", "content"],
  },
};
