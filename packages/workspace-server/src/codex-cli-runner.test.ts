import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CodexCliRunner,
  codexChildEnvironment,
  inspectCodexJsonlEvent,
} from "./codex-cli-runner.js";

describe("Codex CLI process boundary", () => {
  it("rejects command, file, web, and MCP item events", () => {
    for (const type of ["command_execution", "file_change", "web_search", "mcp_tool_call"]) {
      expect(() => inspectCodexJsonlEvent(JSON.stringify({
        type: "item.started",
        item: { id: crypto.randomUUID(), type },
      }))).toThrowError("CODEX_TOOL_ISOLATION_BROKEN");
    }
  });

  it("accepts lifecycle, reasoning, and final answer events", () => {
    expect(() => inspectCodexJsonlEvent(JSON.stringify({ type: "thread.started", thread_id: "opaque" }))).not.toThrow();
    expect(() => inspectCodexJsonlEvent(JSON.stringify({
      type: "item.completed",
      item: { id: "item-1", type: "reasoning", text: "hidden" },
    }))).not.toThrow();
    expect(() => inspectCodexJsonlEvent(JSON.stringify({
      type: "item.completed",
      item: { id: "item-2", type: "agent_message", text: "{}" },
    }))).not.toThrow();
    expect(() => inspectCodexJsonlEvent(JSON.stringify({
      type: "item.completed",
      item: { id: "item-3", type: "error", message: "transport fallback" },
    }))).not.toThrow();
  });

  it("passes only runtime essentials to the child process", () => {
    const environment = codexChildEnvironment({
      PATH: "C:\\tools",
      TEMP: "C:\\temp",
      LOCALAPPDATA: "C:\\Users\\reader\\AppData\\Local",
      OPENAI_API_KEY: "must-not-reach-model-tools",
      PROJECT_SECRET: "also-blocked",
    });

    expect(environment).toMatchObject({
      PATH: "C:\\tools",
      TEMP: "C:\\temp",
      LOCALAPPDATA: "C:\\Users\\reader\\AppData\\Local",
      NO_COLOR: "1",
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("PROJECT_SECRET");
  });
});

describe("CodexCliRunner", () => {
  it("sends the exact structured turn over stdin and keeps it out of argv", async () => {
    const question = `什么是 MCP？-${crypto.randomUUID()}\n第二行`;
    const turn = {
      developerInstructions: "Return only the requested JSON. Do not call tools.",
      text: JSON.stringify({ operation: "question", payload: { question } }),
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    } as const;
    const execute = vi.fn(async (request: {
      args: readonly string[];
      cwd: string;
      stdin: string;
      outputFile: string;
    }) => {
      const policy = await readFile(join(request.cwd,"AGENTS.md"), "utf8");
      expect(policy).toContain(turn.developerInstructions);
      expect(request.stdin).toBe(`${turn.developerInstructions}\n\n--- UNTRUSTED INPUT DATA ---\n${turn.text}`);
      expect(request.args.join(" ")).not.toContain(question);
      await writeFile(request.outputFile, JSON.stringify({ answer: question }), "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const runner = new CodexCliRunner({
      executablePath: process.execPath,
      execute,
    });

    await expect(runner.runStructured(turn)).resolves.toEqual({ answer: question });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining([
      "exec",
      "--sandbox",
      "read-only",
      'shell_environment_policy.inherit="none"',
      "shell_environment_policy.ignore_default_excludes=false",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--json",
      "--output-schema",
      "--output-last-message",
      "-",
    ]));
    expect(execute.mock.calls[0]?.[0].args).not.toContain("tools.web_search=null");
  });
});
